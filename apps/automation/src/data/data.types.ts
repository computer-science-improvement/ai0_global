import { z } from 'zod';

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

export interface ReusePolicy { kind: 'never' | 'after_days'; days?: number }

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
]);

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
  status:                 z.enum(['draft', 'active', 'archived']).optional(),
}).strict();
export type SchemaPatch = z.infer<typeof schemaPatchSchema>;
