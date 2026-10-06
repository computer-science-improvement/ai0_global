import { z } from 'zod';

/**
 * Spec 027 FR-004/FR-005: the dashboard menu the owner builds, stored as JSON in
 * the `app_settings` row `ui.nav`. The server validates the SHAPE only: which
 * ids exist is the dashboard's business (its registry ships with the build, and
 * an unknown id is skipped there with a warning, never a crash).
 */
export const NAV_SETTINGS_KEY = 'ui.nav';
/** The newest menu schema this server accepts. A newer one is refused (a stale build must not overwrite it). */
export const NAV_SCHEMA_MAX = 1;

export const NAV_LIMITS = {
  bytes:   32 * 1024,
  groups:  20,
  refs:    150,
  custom:  50,
  pinned:  10,
  label:   40,
  searchKeys:  10,
  searchValue: 200,
} as const;

const ID_RE = /^[a-z0-9_:-]{1,64}$/;

const id = z.string().regex(ID_RE, 'ids are 1–64 chars of a-z, 0-9, _ : -');
const label = z.string().trim().min(1, 'labels are 1–40 characters').max(NAV_LIMITS.label, 'labels are 1–40 characters');
const icon = z.string().regex(/^[a-z0-9-]{1,32}$/, 'unknown icon name');

/** An internal dashboard path: under /app, no protocol, no `//`, `:` or `..`, query in `search`. */
export function isSafeNavPath(s: string): boolean {
  return /^\/app(\/|$)/.test(s) && s.length <= 300
    && !s.includes('//') && !s.includes(':') && !s.includes('..')
    && !/[?#\s\\]/.test(s);
}

const to = z.string().refine(isSafeNavPath, 'a link must be an internal /app path without "//", ":" or ".."');
const search = z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/, 'bad query key'), z.string().max(NAV_LIMITS.searchValue))
  .refine((o) => Object.keys(o).length <= NAV_LIMITS.searchKeys, `at most ${NAV_LIMITS.searchKeys} query params`);

const group = z.object({
  id,
  title:  label.optional(),
  hidden: z.boolean().optional(),
  items:  z.array(id).max(NAV_LIMITS.refs),
}).strict();

const custom = z.object({ id, label, icon, to, search: search.optional() }).strict();

const override = z.object({
  label: label.optional(),
  icon:  icon.optional(),
  badge: z.boolean().optional(),
}).strict();

export const navConfigSchema = z.object({
  schemaVersion: z.number().int().min(1).max(NAV_SCHEMA_MAX, `schemaVersion must be 1–${NAV_SCHEMA_MAX}`),
  groups:    z.array(group).max(NAV_LIMITS.groups, `at most ${NAV_LIMITS.groups} groups`),
  pinned:    z.array(id).max(NAV_LIMITS.pinned, `at most ${NAV_LIMITS.pinned} pinned items`),
  hidden:    z.array(id).max(NAV_LIMITS.refs),
  custom:    z.array(custom).max(NAV_LIMITS.custom, `at most ${NAV_LIMITS.custom} custom links`),
  overrides: z.record(id, override),
}).strict().superRefine((c, ctx) => {
  const refs = c.groups.reduce((n, g) => n + g.items.length, 0) + c.pinned.length + c.hidden.length;
  if (refs > NAV_LIMITS.refs) ctx.addIssue({ code: 'custom', path: ['groups'], message: `at most ${NAV_LIMITS.refs} item references in all` });
  if (Object.keys(c.overrides).length > NAV_LIMITS.refs) ctx.addIssue({ code: 'custom', path: ['overrides'], message: `at most ${NAV_LIMITS.refs} overrides` });
  const dup = (ids: string[]) => ids.find((x, i) => ids.indexOf(x) !== i);
  const g = dup(c.groups.map((x) => x.id));
  if (g) ctx.addIssue({ code: 'custom', path: ['groups'], message: `duplicate group id ${g}` });
  const k = dup(c.custom.map((x) => x.id));
  if (k) ctx.addIssue({ code: 'custom', path: ['custom'], message: `duplicate custom link id ${k}` });
});

export type NavConfig = z.infer<typeof navConfigSchema>;

export type NavValidation =
  | { ok: true; config: NavConfig; json: string }
  | { ok: false; issues: Array<{ path: string; message: string }> };

/** Validate a submitted menu: size first (on the serialized form), then shape. */
export function validateNavConfig(input: unknown): NavValidation {
  let json: string;
  try { json = JSON.stringify(input) ?? ''; } catch { return { ok: false, issues: [{ path: '', message: 'config is not JSON' }] }; }
  if (Buffer.byteLength(json, 'utf8') > NAV_LIMITS.bytes) {
    return { ok: false, issues: [{ path: '', message: `config is larger than ${NAV_LIMITS.bytes / 1024} KB` }] };
  }
  const r = navConfigSchema.safeParse(input);
  if (!r.success) return { ok: false, issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  // Store the normalized form (trimmed labels).
  return { ok: true, config: r.data, json: JSON.stringify(r.data) };
}
