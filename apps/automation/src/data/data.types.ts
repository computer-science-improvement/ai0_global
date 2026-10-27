import { z } from 'zod';
import type { PostRequires } from './post-requires';

/**
 * Spec 032: the unified data store. A dataset is a `data_schemas` row that describes the data and every
 * field in plain words; its rows live in `data_items.data`. These are the shared shapes and the zod
 * schemas that validate schema definitions coming from the API.
 */

export const FIELD_TYPES = [
  'text', 'long_text', 'int', 'number', 'bool', 'date', 'datetime', 'month_day',
  'url', 'image_url', 'enum', 'text_list', 'json',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Universal roles; the store fills the matching `data_items` envelope columns from them. */
export const ROLE_NAMES = [
  'title', 'body', 'image', 'url', 'category', 'date', 'month_day', 'month', 'day', 'lang',
  'source_name', 'source_url', 'license',
] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
export const SCHEMA_KEY_RE = /^[a-z][a-z0-9_]{1,62}$/;

export interface FieldDef {
  name:           string;
  type:           FieldType;
  description:    string;
  required?:      boolean;
  agent_visible?: boolean;
  searchable?:    boolean;
  filterable?:    boolean;
  example?:       unknown;
  enum?:          string[];
  deprecated?:    boolean;
  default?:       unknown;
  /** Stamped by the database on fields added after version 1. */
  since_version?: number;
}

export type Roles = Partial<Record<RoleName, string | string[]>>;

/**
 * When a row may be posted again on a resource (migration 058 / 096):
 *   • never       — once per resource, for ever;
 *   • after_days  — again N days after its own last post;
 *   • cycle       — spec 071: every row once per round; when the resource has used them all, a new round starts.
 *                   `sequential` goes through `order_by` (else import order), `random` through the rows left in the
 *                   round. `order_by` names scalar fields of the dataset (at most three).
 */
export type ReusePolicy =
  | { kind: 'never' }
  | { kind: 'after_days'; days: number }
  | { kind: 'cycle'; order: 'sequential' | 'random'; order_by?: string[] };

/** Field types a sequential round may sort by. */
export const ORDERABLE_TYPES: readonly FieldType[] = ['int', 'number', 'date', 'datetime', 'month_day', 'text', 'enum'];

/** What is wrong with a cycle policy's `order_by` against the dataset's fields (null when fine). */
export function reuseOrderByIssue(policy: { kind: string; order_by?: string[] } | undefined, fields: Pick<FieldDef, 'name' | 'type'>[]): string | null {
  if (policy?.kind !== 'cycle' || !policy.order_by?.length) return null;
  const byName = new Map(fields.map((f) => [f.name, f]));
  for (const n of policy.order_by) {
    const f = byName.get(n);
    if (!f) return `order_by points to unknown field ${n}`;
    if (!ORDERABLE_TYPES.includes(f.type)) return `order_by field ${n} is ${f.type}; use a number, date, text or enum field`;
  }
  return null;
}

export interface DataSchema {
  id:                     string;
  key:                    string;
  title:                  string;
  description:            string;
  entity:                 string;
  version:                number;
  fields:                 FieldDef[];
  roles:                  Roles;
  dedup_key:              string[];
  language:               string | null;
  default_license:        string;
  reuse_policy:           ReusePolicy;
  suitable_for:           string;
  contains_personal_data: boolean;
  legacy:                 { table: string; id: 'uuid' | 'text'; id_field?: string } | null;
  /** Groups of fields a row needs before it can be posted (migration 083; see post-requires.ts). */
  post_requires?:         PostRequires;
  status:                 'draft' | 'active' | 'archived';
  created_by:             string | null;
  created_at:             string;
  updated_at:             string;
}

export interface UpsertError { row: number; field: string | null; error: string }

export interface UpsertResult {
  inserted:     number;
  updated:      number;
  skipped:      number;
  invalid:      UpsertError[];
  invalid_rows: number;
}

export const fieldDefSchema = z.object({
  name:          z.string().regex(FIELD_NAME_RE, 'field names are snake_case: a-z, 0-9 and _'),
  type:          z.enum(FIELD_TYPES),
  description:   z.string().max(2000).default(''),
  required:      z.boolean().optional(),
  agent_visible: z.boolean().optional(),
  searchable:    z.boolean().optional(),
  filterable:    z.boolean().optional(),
  example:       z.unknown().optional(),
  enum:          z.array(z.string().min(1).max(200)).min(1).max(500).optional(),
  deprecated:    z.boolean().optional(),
  default:       z.unknown().optional(),
  since_version: z.number().int().positive().optional(),
}).refine((f) => f.type !== 'enum' || (f.enum?.length ?? 0) > 0, { message: 'an enum field needs a list of values', path: ['enum'] });

const roleValue = z.union([z.string(), z.array(z.string()).min(1).max(5)]);

export const rolesSchema = z.object(
  Object.fromEntries(ROLE_NAMES.map((r) => [r, roleValue.optional()])) as Record<RoleName, z.ZodOptional<typeof roleValue>>,
).strict();

export const reusePolicySchema = z.union([
  z.object({ kind: z.literal('never') }),
  z.object({ kind: z.literal('after_days'), days: z.number().int().min(1).max(3650) }),
  z.object({
    kind:     z.literal('cycle'),
    order:    z.enum(['sequential', 'random']).default('random'),
    order_by: z.array(z.string().regex(FIELD_NAME_RE)).min(1).max(3)
      .refine((a) => new Set(a).size === a.length, { message: 'order_by names a field twice' }).optional(),
  }),
]);

/** Groups of field names a row needs for posting: every group needs one filled field. */
export const postRequiresSchema = z.array(z.array(z.string().regex(FIELD_NAME_RE)).min(1).max(10)).max(10);

/** Everything an owner may set on a schema. */
export const schemaInputSchema = z.object({
  key:                    z.string().regex(SCHEMA_KEY_RE, 'keys are snake_case: a-z, 0-9 and _, 2–63 characters'),
  title:                  z.string().min(1).max(200),
  description:            z.string().max(4000).default(''),
  entity:                 z.string().min(1).max(60).default('item'),
  fields:                 z.array(fieldDefSchema).min(1).max(200),
  roles:                  rolesSchema.default({}),
  dedup_key:              z.array(z.string()).max(10).default([]),
  language:               z.string().max(20).nullable().optional(),
  default_license:        z.string().max(40).default('unknown'),
  reuse_policy:           reusePolicySchema.default({ kind: 'never' }),
  suitable_for:           z.string().max(2000).default(''),
  contains_personal_data: z.boolean().default(false),
  post_requires:          postRequiresSchema.optional(),
  status:                 z.enum(['draft', 'active', 'archived']).default('active'),
}).superRefine((s, ctx) => {
  const names = new Set<string>();
  for (const f of s.fields) {
    if (names.has(f.name)) ctx.addIssue({ code: 'custom', message: `duplicate field name: ${f.name}`, path: ['fields'] });
    names.add(f.name);
  }
  for (const [role, v] of Object.entries(s.roles)) {
    for (const name of Array.isArray(v) ? v : v ? [v] : []) {
      if (!names.has(name)) ctx.addIssue({ code: 'custom', message: `role ${role} points to unknown field ${name}`, path: ['roles', role] });
    }
  }
  for (const k of s.dedup_key) {
    if (!names.has(k)) ctx.addIssue({ code: 'custom', message: `dedup_key points to unknown field ${k}`, path: ['dedup_key'] });
  }
  for (const k of (s.post_requires ?? []).flat()) {
    if (!names.has(k)) ctx.addIssue({ code: 'custom', message: `post_requires points to unknown field ${k}`, path: ['post_requires'] });
  }
  const orderBy = reuseOrderByIssue(s.reuse_policy, s.fields);
  if (orderBy) ctx.addIssue({ code: 'custom', message: orderBy, path: ['reuse_policy', 'order_by'] });
});
export type SchemaInput = z.infer<typeof schemaInputSchema>;

/** A partial edit; `key` never changes. */
export const schemaPatchSchema = z.object({
  title:                  z.string().min(1).max(200).optional(),
  description:            z.string().max(4000).optional(),
  entity:                 z.string().min(1).max(60).optional(),
  fields:                 z.array(fieldDefSchema).min(1).max(200).optional(),
  roles:                  rolesSchema.optional(),
  dedup_key:              z.array(z.string()).max(10).optional(),
  language:               z.string().max(20).nullable().optional(),
  default_license:        z.string().max(40).optional(),
  reuse_policy:           reusePolicySchema.optional(),
  suitable_for:           z.string().max(2000).optional(),
  contains_personal_data: z.boolean().optional(),
  post_requires:          postRequiresSchema.optional(),
  status:                 z.enum(['draft', 'active', 'archived']).optional(),
}).strict();
export type SchemaPatch = z.infer<typeof schemaPatchSchema>;
