import type { DataSchema, FieldDef, Roles } from './data.types';

/**
 * Schema versioning rules (spec 032 FR-002). The database enforces them in the `data_schemas_guard`
 * trigger; this is the same rule set in TypeScript so the dashboard can preview an edit ("version 3 → 4,
 * 1 240 rows keep their version") and the API can reject a bad edit with a readable message first.
 *
 *   • fields are never removed, renamed or retyped in place → error (deprecate and add a new field);
 *   • enum values can only be added;
 *   • description-only edits (description, example, agent_visible, searchable, filterable, and the
 *     dataset texts) keep the version;
 *   • structural edits (a new field, deprecation, required/default/enum change, roles, dedup key) bump it;
 *   • the dedup key cannot change once the dataset has rows.
 */

const DESCRIPTIVE_FIELD_KEYS = new Set(['description', 'example', 'agent_visible', 'searchable', 'filterable', 'since_version']);

function structure(f: FieldDef): string {
  const entries = Object.entries(f).filter(([k, v]) => !DESCRIPTIVE_FIELD_KEYS.has(k) && v !== undefined);
  entries.sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

function canonicalRoles(r: Roles): string {
  return JSON.stringify(Object.entries(r ?? {}).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)));
}

export interface SchemaChange {
  kind: 'field_added' | 'field_deprecated' | 'field_restored' | 'field_changed' | 'field_described' | 'roles' | 'dedup_key' | 'dataset_text';
  field?: string;
  detail?: string;
}

export interface SchemaDiff {
  structural:  boolean;
  nextVersion: number;
  changes:     SchemaChange[];
  errors:      string[];
}

type Comparable = Pick<DataSchema, 'version' | 'fields' | 'roles' | 'dedup_key'> & Partial<DataSchema>;

export function diffSchemas(prev: Comparable, next: Comparable, opts: { hasRows?: boolean } = {}): SchemaDiff {
  const changes: SchemaChange[] = [];
  const errors: string[] = [];
  let structural = false;
  const nextByName = new Map(next.fields.map((f) => [f.name, f]));

  for (const o of prev.fields) {
    const n = nextByName.get(o.name);
    if (!n) { errors.push(`field "${o.name}" cannot be removed or renamed; mark it deprecated instead`); continue; }
    if (n.type !== o.type) {
      errors.push(`type of field "${o.name}" cannot change (${o.type} to ${n.type}); add a new field and deprecate this one`);
      continue;
    }
    if (o.type === 'enum' && (o.enum ?? []).some((v) => !(n.enum ?? []).includes(v))) {
      errors.push(`enum values of field "${o.name}" can only be added, not removed`);
    }
    if (structure(n) !== structure(o)) {
      structural = true;
      const kind = !o.deprecated && n.deprecated ? 'field_deprecated' : o.deprecated && !n.deprecated ? 'field_restored' : 'field_changed';
      changes.push({ kind, field: o.name });
    } else if (['description', 'example', 'agent_visible', 'searchable', 'filterable'].some((k) => JSON.stringify((n as any)[k]) !== JSON.stringify((o as any)[k]))) {
      changes.push({ kind: 'field_described', field: o.name });
    }
  }
  const prevNames = new Set(prev.fields.map((f) => f.name));
  for (const n of next.fields) {
    if (!prevNames.has(n.name)) {
      structural = true;
      const note = n.required && n.default === undefined ? 'required only for rows written from the new version on' : undefined;
      changes.push({ kind: 'field_added', field: n.name, detail: note });
    }
  }
  if (canonicalRoles(prev.roles) !== canonicalRoles(next.roles)) { structural = true; changes.push({ kind: 'roles' }); }
  if (JSON.stringify(prev.dedup_key ?? []) !== JSON.stringify(next.dedup_key ?? [])) {
    if (opts.hasRows) errors.push('dedup_key cannot change once the dataset has rows');
    structural = true;
    changes.push({ kind: 'dedup_key' });
  }
  for (const k of ['title', 'description', 'entity', 'suitable_for', 'language', 'default_license', 'status', 'contains_personal_data'] as const) {
    if (k in next && next[k] !== undefined && JSON.stringify(next[k]) !== JSON.stringify(prev[k])) changes.push({ kind: 'dataset_text', field: k });
  }
  return { structural, nextVersion: structural ? prev.version + 1 : prev.version, changes, errors };
}
