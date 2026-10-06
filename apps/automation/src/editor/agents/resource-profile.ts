import type { Pool } from 'pg';
import { z } from 'zod';
import { localTimeLabel } from '../roles/time';
import { DEFAULT_TZ, isValidTimeZone } from '../time/resource-time';

export const KPI_GOALS = ['growth', 'engagement', 'transitions', 'revenue'] as const;
export type KpiGoal = typeof KPI_GOALS[number];

export const KPI_GOAL_UK: Record<KpiGoal, string> = {
  growth: 'ріст підписників', engagement: 'охоплення і залученість', transitions: 'переходи між ресурсами', revenue: 'дохід і реклама',
};

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

/** A stored profile; an invalid stored zone is dropped (the resolver falls back to Kyiv) instead of losing the profile. */
function parseStoredProfile(raw: unknown) {
  const parsed = ResourceProfileSchema.safeParse(raw);
  if (parsed.success || !raw || typeof raw !== 'object' || !('timezone' in raw)) return parsed;
  const { timezone: _drop, ...rest } = raw as Record<string, unknown>;
  return ResourceProfileSchema.safeParse(rest);
}

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

  async setProfile(ref: string, profile: ResourceProfile, by: 'owner' | 'builder' | 'agent'): Promise<void> {
    await this.pool.query(
      `INSERT INTO resource_profiles (resource_ref, profile, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (resource_ref) DO UPDATE SET profile = EXCLUDED.profile, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [ref, JSON.stringify(profile), by]);
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
