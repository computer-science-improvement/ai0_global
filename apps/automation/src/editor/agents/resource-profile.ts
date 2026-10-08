import type { Pool } from 'pg';
import { z } from 'zod';
import { localTimeLabel } from '../roles/time';
import { DEFAULT_TZ, isValidTimeZone } from '../time/resource-time';

export const KPI_GOALS = ['growth', 'engagement', 'transitions', 'revenue'] as const;
export type KpiGoal = typeof KPI_GOALS[number];

export const KPI_GOAL_UK: Record<KpiGoal, string> = {
  growth: 'ріст підписників', engagement: 'охоплення і залученість', transitions: 'переходи між ресурсами', revenue: 'дохід і реклама',
};

/**
 * Spec 024 FR-013: how posts on this resource are presented. Every field is
 * optional — empty means "the agent's judgement". Agents change them with
 * update_resource_format; the owner edits them and can lock any field.
 * Platform hard limits stay in code (capabilities.ts), never here.
 */
export const FORMAT_PREF_FIELDS = [
  'tone', 'length', 'emoji', 'hashtags', 'mentions', 'cta', 'links', 'line_breaks', 'signature', 'preferred_formats', 'media', 'notes',
  'rich',
] as const;
export type FormatPrefField = typeof FORMAT_PREF_FIELDS[number];

export const FormatPrefsSchema = z.object({
  tone:              z.string().trim().min(1).max(200).optional(),
  length:            z.object({ target: z.number().int().min(10).max(6000), max: z.number().int().min(10).max(60_000) })
    .refine((l) => l.target <= l.max, { message: 'target ≤ max' }).optional(),
  emoji:             z.enum(['none', 'light', 'rich']).optional(),
  hashtags:          z.object({
    count: z.number().int().min(0).max(30),
    style: z.string().trim().max(60).optional(),
    fixed: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  }).optional(),
  mentions:          z.string().trim().min(1).max(200).optional(),
  cta:               z.string().trim().min(1).max(200).optional(),
  links:             z.enum(['inline', 'bio', 'first_comment', 'button']).optional(),
  line_breaks:       z.string().trim().min(1).max(120).optional(),
  signature:         z.string().trim().min(1).max(200).optional(),
  preferred_formats: z.array(z.string().trim().min(2).max(30)).max(10).optional(),
  media:             z.object({ aspect: z.string().trim().max(20).optional(), cover_style: z.string().trim().max(120).optional() }).optional(),
  notes:             z.string().trim().min(1).max(1000).optional(),
  /** Spec 033 FR-005: Telegram rich messages — auto (when the post uses headings/tables/…), prefer (every text post), never. */
  rich:              z.enum(['auto', 'prefer', 'never']).optional(),
}).strict();
export type FormatPrefs = z.infer<typeof FormatPrefsSchema>;

/** Fields the owner locked: read-only to agents (`locked_by_owner`). */
export const FormatLocksSchema = z.array(z.enum(FORMAT_PREF_FIELDS)).max(FORMAT_PREF_FIELDS.length);

const FORMAT_UK: Record<FormatPrefField, string> = {
  tone: 'Тон', length: 'Довжина', emoji: 'Емодзі', hashtags: 'Хештеги', mentions: 'Згадки', cta: 'Заклик', links: 'Посилання',
  line_breaks: 'Абзаци', signature: 'Підпис', preferred_formats: 'Бажані формати', media: 'Медіа', notes: 'Нотатки',
  rich: 'Rich-повідомлення Telegram',
};
const EMOJI_UK = { none: 'без емодзі', light: 'кілька', rich: 'багато' } as const;
const LINKS_UK = { inline: 'у тексті', bio: 'посилання в біо', first_comment: 'перший коментар', button: 'кнопка' } as const;
const RICH_UK = {
  auto: 'авто — коли в пості є заголовки, таблиці, нумеровані списки, формули',
  prefer: 'завжди для текстових постів', never: 'ніколи — лише звичайний HTML',
} as const;

function formatValue(k: FormatPrefField, v: unknown): string {
  switch (k) {
    case 'length':   { const l = v as { target: number; max: number }; return `~${l.target} символів, максимум ${l.max}`; }
    case 'emoji':    return EMOJI_UK[v as keyof typeof EMOJI_UK] ?? String(v);
    case 'links':    return LINKS_UK[v as keyof typeof LINKS_UK] ?? String(v);
    case 'rich':     return RICH_UK[v as keyof typeof RICH_UK] ?? String(v);
    case 'hashtags': {
      const h = v as { count: number; style?: string; fixed?: string[] };
      return [`${h.count}`, h.style, h.fixed?.length ? `завжди: ${h.fixed.map((x) => `#${x.replace(/^#/, '')}`).join(' ')}` : ''].filter(Boolean).join(', ');
    }
    case 'preferred_formats': return (v as string[]).join(', ');
    case 'media':    { const m = v as { aspect?: string; cover_style?: string }; return [m.aspect, m.cover_style].filter(Boolean).join(', '); }
    default:         return String(v);
  }
}

/** format_prefs for prompts (Ukrainian, like the rest of the prompt); locked fields are marked. Empty → null. */
export function renderFormatPrefs(prefs: FormatPrefs | null | undefined, locks: readonly string[] = []): string | null {
  if (!prefs) return null;
  const lines = FORMAT_PREF_FIELDS.filter((k) => prefs[k] !== undefined)
    .map((k) => `${FORMAT_UK[k]}: ${formatValue(k, prefs[k])}${locks.includes(k) ? ' (закріплено власником)' : ''}`);
  return lines.length ? lines.join('\n') : null;
}

/** Field-level diff of two format_prefs (`{ field: { from, to } }`). */
export function diffFormatPrefs(a: FormatPrefs | null | undefined, b: FormatPrefs | null | undefined): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of FORMAT_PREF_FIELDS) {
    const x = a?.[k] ?? null;
    const y = b?.[k] ?? null;
    if (JSON.stringify(x) !== JSON.stringify(y)) out[k] = { from: x, to: y };
  }
  return out;
}

/** What an agent's resource is about (spec 018 FR-006). Always in the agent's prompt. */
export const ResourceProfileSchema = z.object({
  topic:          z.string().trim().min(3).max(300),
  audience:       z.object({
    who:    z.string().trim().min(2).max(200),
    age:    z.string().trim().max(40).optional(),
    region: z.string().trim().max(80).optional(),
  }),
  language:       z.string().trim().min(2).max(10).default('uk'),
  goals:          z.array(z.enum(KPI_GOALS)).min(1).max(4),
  tone:           z.string().trim().max(300).optional(),
  taboo:          z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  sources:        z.array(z.string().trim().min(3).max(300)).max(30).default([]),
  frequency_hint: z.string().trim().max(120).optional(),
  ads_allowed:    z.object({ allowed: z.boolean(), categories: z.array(z.string().trim().max(60)).max(20).default([]) }).default({ allowed: true, categories: [] }),
  examples:       z.array(z.string().trim().min(2).max(200)).max(10).default([]),
  notes:          z.string().trim().max(800).optional(),
  /**
   * Spec 024 FR-004: the resource's IANA zone (absent = Europe/Kyiv) and quiet
   * hours (absent = 23→8). Ignored for telegram: refs — the editor card is authoritative.
   */
  timezone:       z.string().trim().max(64).refine(isValidTimeZone, { message: 'unknown IANA time zone (e.g. Europe/Kyiv, America/New_York)' }).optional(),
  quiet_hours:    z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(23) }).optional(),
  /** Spec 024 FR-013: presentation on this resource (agent-owned) and the fields the owner locked. */
  format_prefs:   FormatPrefsSchema.optional(),
  format_locks:   FormatLocksSchema.optional(),
});
export type ResourceProfile = z.infer<typeof ResourceProfileSchema>;

export const PROFILE_PROMPT_LIMIT = 1500;

/**
 * Compact Ukrainian rendering for system prompts (≤ PROFILE_PROMPT_LIMIT characters).
 * The zone line appears only outside Kyiv and never for Telegram refs (their card's zone rules).
 */
export function renderProfile(p: ResourceProfile, o: { now?: Date; ref?: string } = {}): string {
  const tzLine = p.timezone && p.timezone !== DEFAULT_TZ && !o.ref?.startsWith('telegram:')
    ? `Часовий пояс: ${p.timezone} (зараз ${localTimeLabel(o.now ?? new Date(), p.timezone)})`
    : '';
  const lines = [
    `Тема: ${p.topic}`,
    `Аудиторія: ${p.audience.who}${p.audience.age ? `, ${p.audience.age}` : ''}${p.audience.region ? `, ${p.audience.region}` : ''}`,
    `Мова: ${p.language}`,
    `Цілі (за пріоритетом): ${p.goals.map((g) => KPI_GOAL_UK[g]).join(' → ')}`,
    p.tone ? `Тон: ${p.tone}` : '',
    p.taboo.length ? `Табу: ${p.taboo.join(', ')}` : '',
    p.sources.length ? `Джерела: ${p.sources.join('; ')}` : '',
    p.frequency_hint ? `Частота: ${p.frequency_hint}` : '',
    `Реклама: ${p.ads_allowed.allowed ? `так${p.ads_allowed.categories.length ? ` (${p.ads_allowed.categories.join(', ')})` : ''}` : 'ні'}`,
    p.examples.length ? `Орієнтири: ${p.examples.join(', ')}` : '',
    p.notes ? `Нотатки: ${p.notes}` : '',
    tzLine,
  ].filter(Boolean).join('\n');
  return lines.length > PROFILE_PROMPT_LIMIT ? `${lines.slice(0, PROFILE_PROMPT_LIMIT - 1)}…` : lines;
}

/**
 * A stored profile; an invalid stored zone or invalid formatting fields are dropped (the resolver falls back to Kyiv,
 * formatting to the agent's judgement) instead of losing the profile.
 */
function parseStoredProfile(raw: unknown) {
  const parsed = ResourceProfileSchema.safeParse(raw);
  if (parsed.success || !raw || typeof raw !== 'object') return parsed;
  const { timezone: _tz, ...noTz } = raw as Record<string, unknown>;
  const second = ResourceProfileSchema.safeParse(noTz);
  if (second.success) return second;
  const { format_prefs: _fp, format_locks: _fl, ...plain } = noTz;
  return ResourceProfileSchema.safeParse(plain);
}

/** The format_prefs and locks of a stored profile JSON (valid even when the rest of the profile is not). */
export function storedFormat(raw: unknown): { prefs: FormatPrefs; locks: FormatPrefField[] } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const prefs = FormatPrefsSchema.safeParse(r.format_prefs ?? {});
  const locks = FormatLocksSchema.safeParse(r.format_locks ?? []);
  return { prefs: prefs.success ? prefs.data : {}, locks: locks.success ? [...new Set(locks.data)] : [] };
}

export interface ProfileVersion {
  id:          number;
  resourceRef: string;
  version:     number;
  kind:        'profile' | 'format';
  changedBy:   'owner' | 'builder' | 'agent' | 'system';
  agentId:     string | null;
  reason:      string | null;
  diff:        Record<string, { from: unknown; to: unknown }>;
  createdAt:   Date;
}

/** Agent changes of one resource's format_prefs per local day (FR-013). */
export const FORMAT_CHANGES_PER_DAY = 3;

export type FormatPatchResult =
  | { ok: true; version: number; format_prefs: FormatPrefs; changed: string[] }
  | { error: 'locked_by_owner' | 'daily_limit' | 'invalid_patch' | 'no_change'; details?: unknown };

export type HealthState = 'ok' | 'no_access' | 'token_expiring' | 'token_invalid' | 'rate_limited' | 'unknown';
export interface ResourceHealth {
  state:     HealthState;
  detail?:   string;
  checkedAt: string;
}

export interface StoredProfile {
  resourceRef: string;
  profile:     ResourceProfile | null;
  health:      ResourceHealth | null;
  updatedBy:   string;
  updatedAt:   Date;
}

/** resource_profiles (050). */
export class ResourceProfilesRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async get(ref: string): Promise<StoredProfile | null> {
    const { rows } = await this.pool.query(`SELECT * FROM resource_profiles WHERE resource_ref = $1`, [ref]);
    if (!rows[0]) return null;
    const parsed = parseStoredProfile(rows[0].profile);
    return {
      resourceRef: ref, profile: parsed.success ? parsed.data : null, health: rows[0].resource_health ?? null,
      updatedBy: rows[0].updated_by, updatedAt: rows[0].updated_at,
    };
  }

  async list(): Promise<StoredProfile[]> {
    const { rows } = await this.pool.query(`SELECT * FROM resource_profiles ORDER BY resource_ref`);
    return rows.map((r) => {
      const parsed = parseStoredProfile(r.profile);
      return { resourceRef: r.resource_ref, profile: parsed.success ? parsed.data : null, health: r.resource_health ?? null, updatedBy: r.updated_by, updatedAt: r.updated_at };
    });
  }

  /**
   * Save a whole profile. A profile without `format_prefs` / `format_locks` keeps the stored ones (callers that do not
   * know the formatting never wipe it). Every change is a version (FR-013).
   */
  async setProfile(ref: string, profile: ResourceProfile, by: 'owner' | 'builder' | 'agent', meta: { agentId?: string | null; reason?: string | null } = {}): Promise<void> {
    await this.tx(async (q) => {
      const { rows } = await q.query(`SELECT profile FROM resource_profiles WHERE resource_ref = $1 FOR UPDATE`, [ref]);
      const prev = (rows[0]?.profile ?? null) as Record<string, unknown> | null;
      const keep = storedFormat(prev);
      const next: Record<string, unknown> = { ...profile };
      if (next.format_prefs === undefined && Object.keys(keep.prefs).length) next.format_prefs = keep.prefs;
      if (next.format_locks === undefined && keep.locks.length) next.format_locks = keep.locks;
      await q.query(
        `INSERT INTO resource_profiles (resource_ref, profile, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (resource_ref) DO UPDATE SET profile = EXCLUDED.profile, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [ref, JSON.stringify(next), by]);
      const diff: Record<string, { from: unknown; to: unknown }> = {};
      for (const k of new Set([...Object.keys(prev ?? {}), ...Object.keys(next)])) {
        if (k === 'format_prefs') continue;
        const a = prev?.[k] ?? null; const b = next[k] ?? null;
        if (JSON.stringify(a) !== JSON.stringify(b)) diff[k] = { from: a, to: b };
      }
      for (const [k, v] of Object.entries(diffFormatPrefs(keep.prefs, storedFormat(next).prefs))) diff[`format_prefs.${k}`] = v;
      if (Object.keys(diff).length) await this.addVersion(q, ref, 'profile', by, meta.agentId ?? null, meta.reason ?? null, diff, next);
    });
  }

  /** format_prefs, owner locks and the last change of a resource (empty when it has no row). */
  async formatOf(ref: string): Promise<{ prefs: FormatPrefs; locks: FormatPrefField[]; updatedAt: Date | null }> {
    const { rows } = await this.pool.query(`SELECT profile, updated_at FROM resource_profiles WHERE resource_ref = $1`, [ref]);
    return { ...storedFormat(rows[0]?.profile), updatedAt: rows[0]?.updated_at ?? null };
  }

  /** Agent changes of format_prefs on the resource's local day (resource_tz). */
  async formatChangesToday(ref: string, now: Date = new Date()): Promise<number> {
    return this.formatChangesTodayQ(this.pool, ref, now);
  }

  /**
   * Change format_prefs (FR-013). `patch`: a field → its new value, null clears it. An agent cannot touch
   * owner-locked fields and has 3 changes per resource per local day; the owner may also replace the locks.
   * Works for resources without a full profile (only format_prefs is stored then).
   */
  async patchFormat(
    ref: string, patch: Record<string, unknown>,
    meta: { by: 'agent' | 'owner'; agentId?: string | null; reason?: string | null; locks?: FormatPrefField[]; replace?: boolean; now?: Date },
  ): Promise<FormatPatchResult> {
    return this.tx(async (q): Promise<FormatPatchResult> => {
      const { rows } = await q.query(`SELECT profile FROM resource_profiles WHERE resource_ref = $1 FOR UPDATE`, [ref]);
      const raw = (rows[0]?.profile ?? {}) as Record<string, unknown>;
      const cur = storedFormat(raw);
      const keys = Object.keys(patch);
      const unknown = keys.filter((k) => !(FORMAT_PREF_FIELDS as readonly string[]).includes(k));
      if (unknown.length) return { error: 'invalid_patch', details: `unknown fields: ${unknown.join(', ')} (allowed: ${FORMAT_PREF_FIELDS.join(', ')})` };
      if (meta.by === 'agent') {
        const locked = keys.filter((k) => cur.locks.includes(k as FormatPrefField));
        if (locked.length) return { error: 'locked_by_owner', details: locked };
        if (await this.formatChangesTodayQ(q, ref, meta.now ?? new Date()) >= FORMAT_CHANGES_PER_DAY) {
          return { error: 'daily_limit', details: `${FORMAT_CHANGES_PER_DAY} format changes a day on ${ref}` };
        }
      }
      const merged: Record<string, unknown> = meta.replace ? {} : { ...cur.prefs };
      for (const k of keys) { if (patch[k] === null) delete merged[k]; else merged[k] = patch[k]; }
      const parsed = FormatPrefsSchema.safeParse(merged);
      if (!parsed.success) return { error: 'invalid_patch', details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
      const locks = meta.by === 'owner' && meta.locks ? [...new Set(meta.locks)] : cur.locks;
      const diff = diffFormatPrefs(cur.prefs, parsed.data);
      const lockDiff = JSON.stringify([...cur.locks].sort()) !== JSON.stringify([...locks].sort());
      if (!Object.keys(diff).length && !lockDiff) return { error: 'no_change' };
      const next = { ...raw, format_prefs: parsed.data, format_locks: locks };
      await q.query(
        `INSERT INTO resource_profiles (resource_ref, profile, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (resource_ref) DO UPDATE SET profile = EXCLUDED.profile, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [ref, JSON.stringify(next), meta.by]);
      const full = lockDiff ? { ...diff, format_locks: { from: cur.locks, to: locks } } : diff;
      const version = await this.addVersion(q, ref, 'format', meta.by, meta.agentId ?? null, meta.reason ?? null, full, next);
      return { ok: true, version, format_prefs: parsed.data, changed: Object.keys(full) };
    });
  }

  /** Version history of resources (newest first). */
  async history(refs: string[], limit = 50): Promise<ProfileVersion[]> {
    if (!refs.length) return [];
    const { rows } = await this.pool.query(
      `SELECT * FROM resource_profile_versions WHERE resource_ref = ANY($1::text[]) ORDER BY created_at DESC, id DESC LIMIT $2`, [refs, limit]);
    return rows.map((r) => ({
      id: Number(r.id), resourceRef: r.resource_ref, version: Number(r.version), kind: r.kind, changedBy: r.changed_by,
      agentId: r.agent_id ?? null, reason: r.reason ?? null, diff: r.diff ?? {}, createdAt: r.created_at,
    }));
  }

  private async formatChangesTodayQ(q: Pick<Pool, 'query'>, ref: string, now: Date): Promise<number> {
    const { rows } = await q.query(
      `SELECT COUNT(*)::int AS n FROM resource_profile_versions
        WHERE resource_ref = $1 AND kind = 'format' AND changed_by = 'agent'
          AND (created_at AT TIME ZONE resource_tz($1))::date = ($2::timestamptz AT TIME ZONE resource_tz($1))::date`, [ref, now]);
    return Number(rows[0]?.n ?? 0);
  }

  private async addVersion(q: Pick<Pool, 'query'>, ref: string, kind: 'profile' | 'format', by: string, agentId: string | null, reason: string | null, diff: unknown, profile: unknown): Promise<number> {
    const { rows } = await q.query(
      `INSERT INTO resource_profile_versions (resource_ref, version, kind, changed_by, agent_id, reason, diff, profile)
       SELECT $1, COALESCE(MAX(version), 0) + 1, $2, $3, $4, $5, $6, $7 FROM resource_profile_versions WHERE resource_ref = $1
       RETURNING version`,
      [ref, kind, by, agentId, reason, JSON.stringify(diff), JSON.stringify(profile)]);
    return Number(rows[0].version);
  }

  /** One transaction when the pool can give a client (a plain query object in unit tests runs without one). */
  private async tx<T>(fn: (q: Pick<Pool, 'query'>) => Promise<T>): Promise<T> {
    const pool = this.pool as Partial<Pool>;
    if (typeof pool.connect !== 'function') return fn(this.pool);
    const client = await (this.pool as Pool).connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** The stored profile JSON as is (the time resolver must see an invalid stored zone). */
  async rawProfile(ref: string): Promise<Record<string, any> | null> {
    const { rows } = await this.pool.query(`SELECT profile FROM resource_profiles WHERE resource_ref = $1`, [ref]);
    return rows[0]?.profile ?? null;
  }

  /** Adds a warning to resource_health.detail without changing its state (spec 024: invalid stored zone). */
  async noteHealthDetail(ref: string, detail: string): Promise<void> {
    await this.pool.query(
      `UPDATE resource_profiles SET resource_health = COALESCE(resource_health, '{}'::jsonb) || jsonb_build_object('detail', $2::text)
        WHERE resource_ref = $1 AND COALESCE(resource_health->>'detail', '') <> $2`, [ref, detail]);
  }

  /** Returns the previous state so callers can notify on a change. */
  async setHealth(ref: string, health: ResourceHealth): Promise<HealthState | null> {
    const prev = await this.pool.query(`SELECT resource_health FROM resource_profiles WHERE resource_ref = $1`, [ref]);
    await this.pool.query(
      `INSERT INTO resource_profiles (resource_ref, resource_health, updated_by) VALUES ($1, $2, 'system')
       ON CONFLICT (resource_ref) DO UPDATE SET resource_health = EXCLUDED.resource_health`,
      [ref, JSON.stringify(health)]);
    return (prev.rows[0]?.resource_health?.state as HealthState | undefined) ?? null;
  }
}
