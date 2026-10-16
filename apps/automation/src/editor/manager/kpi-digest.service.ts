import { createHash } from 'crypto';
import { localDate } from '../roles/time';
import type { Pool } from 'pg';
import type { ResourceCatalog } from '../agents/resource-catalog';
import { compactKpis, computeKpis, DailySeries, dayBefore, ScopeKpis } from './kpi-math';
import { markSampleConfidence } from './kpi-confidence';
import { qualitySignature, slimQuality, SqlQuality, type ResourceQuality } from './quality-digest';

/** Spec 034 T4: the quality blocks (≤ ~3k chars per busy resource) raised the bound from 12k; render() slims to it. */
export const DIGEST_LIMIT_CHARS = 20_000;

export interface ResourceDigest {
  ref:       string;
  title:     string | null;
  agent:     string | null;
  health:    string | null;
  kpis:      ReturnType<typeof compactKpis>;
  anomalies: string[];
  /** Spec 034 FR-006: the content-quality block (7 days); null when it could not be read. */
  quality?:  ResourceQuality | null;
}

export interface KpiDigest {
  generatedAt: string;
  today:       string;
  resources:   ResourceDigest[];
  agents:      Array<{ handle: string; mode: string; paused: boolean; slotsToday: Record<string, number>; spentTodayUsd: number }>;
  budget:      { spentTodayUsd: number; capUsd: number };
  directives:  { open: Array<{ id: string; to: string; kind: string; status: string; body: string; createdAt: string }>; outcomes: Array<{ to: string; kind: string; outcome: string | null; body: string; detail: unknown }> };
  /** Spec 025 FR-017: how each orchestrator answered the MANAGER over 30 days. */
  compliance?: ComplianceRow[];
  hash:        string;
  raw:         Map<string, ScopeKpis>;
}

export interface ComplianceRow {
  agent:            string;
  advice_followed:  number;
  advice_declined:  number;
  /** The last 3 decline reasons, newest first. */
  decline_reasons:  Array<{ kind: string; reason: string }>;
  contested:        number;
  auto_applied:     number;
}

export const COMPLIANCE_DAYS = 30;

/** Spec 025 FR-017: the compliance block — advice followed / declined (+ the last 3 reasons), directives contested and auto-applied. */
export async function complianceOf(pool: Pick<Pool, 'query'>, days = COMPLIANCE_DAYS): Promise<ComplianceRow[]> {
  const { rows } = await pool.query(
    `SELECT a.handle,
            COUNT(*) FILTER (WHERE d.binding = 'advice' AND d.status IN ('accepted','applied','evaluated'))::int AS advice_followed,
            COUNT(*) FILTER (WHERE d.binding = 'advice' AND d.status = 'declined')::int AS advice_declined,
            COUNT(*) FILTER (WHERE d.contested_at IS NOT NULL)::int AS contested,
            COUNT(*) FILTER (WHERE d.resolution LIKE 'auto-applied:%')::int AS auto_applied,
            (SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', x.reason_kind, 'reason', left(x.resolution, 160)) ORDER BY x.updated_at DESC), '[]'::jsonb)
               FROM (SELECT reason_kind, resolution, updated_at FROM agent_directives
                      WHERE to_agent_id = a.id AND status = 'declined' AND NOT shadow AND created_at >= now() - ($1 || ' days')::interval
                      ORDER BY updated_at DESC LIMIT 3) x) AS reasons
       FROM agent_directives d JOIN agents a ON a.id = d.to_agent_id
      WHERE NOT d.shadow AND d.created_at >= now() - ($1 || ' days')::interval
      GROUP BY a.id, a.handle ORDER BY a.handle`, [String(days)]);
  return rows.map((r) => ({
    agent: r.handle, advice_followed: Number(r.advice_followed), advice_declined: Number(r.advice_declined),
    decline_reasons: (r.reasons ?? []).map((x: any) => ({ kind: x.kind ?? '—', reason: x.reason ?? '' })),
    contested: Number(r.contested), auto_applied: Number(r.auto_applied),
  }));
}

export interface KpiDigestDeps {
  pool:    Pick<Pool, 'query'>;
  catalog: Pick<ResourceCatalog, 'list'>;
  /** The agents' daily cap; `capUsd` (llm_budgets, owner-editable) wins when given. */
  globalCapUsd: number;
  capUsd?: () => Promise<number>;
  /** Spec 034 FR-006: the quality reader (default: SQL on the same pool). */
  quality?: Pick<SqlQuality, 'digest'>;
  now?:    () => Date;
}

const kyivDay = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' });

function series(): { viewsPerPost: DailySeries; engagementRate: DailySeries; posts: DailySeries; followerDelta: DailySeries; joins: DailySeries; revenue: DailySeries } {
  return { viewsPerPost: new Map(), engagementRate: new Map(), posts: new Map(), followerDelta: new Map(), joins: new Map(), revenue: new Map() };
}

/**
 * The digest hash the MANAGER's skip compares (spec 021, extended by spec 034 FR-006): the KPIs, the open
 * directives and the quality signature — a new critic reject/revise, a new owner rejection/edit or a new quality
 * flag (cap overflow, low pass rate) changes it, so such a run is never skipped.
 */
export function digestHash(d: Pick<KpiDigest, 'resources' | 'directives'>): string {
  return createHash('sha1').update(JSON.stringify({
    r: d.resources.map((x) => [x.ref, x.kpis]), o: d.directives.open.map((x) => [x.id, x.status]), q: qualitySignature(d.resources),
  })).digest('hex');
}

const flagged = (r: ResourceDigest) => (r.quality?.flags.length ?? 0) > 0;

/** See KpiDigestService.render. */
export function renderDigest(d: KpiDigest, limit = DIGEST_LIMIT_CHARS): string {
  const strip = (x: object) => JSON.stringify({ ...x, raw: undefined, hash: undefined });
  const map = (f: (r: ResourceDigest) => object) => ({ ...d, resources: d.resources.map(f) });
  const short = (r: ResourceDigest) => (r.quality ? { ...r, quality: slimQuality(r.quality, { samples: flagged(r) ? 1 : 0, sampleChars: 200 }) } : r);
  const steps: Array<() => string> = [
    () => strip(d),
    () => strip(map((r) => (r.quality && !flagged(r) ? { ...r, quality: slimQuality(r.quality, { samples: 0, sampleChars: 0 }) } : r))),
    () => strip(map(short)),
    () => strip(map((r) => (r.anomalies.length || flagged(r) ? short(r) : { ref: r.ref, agent: r.agent, anomalies: [], note: 'без аномалій і прапорців якості' }))),
  ];
  let s = '';
  for (const step of steps) {
    s = step();
    if (s.length <= limit) return s;
  }
  return `${s.slice(0, limit - 20)}…(обрізано)`;
}

/**
 * The MANAGER's view of the network (spec 021 FR-002): code computes every
 * number; the model only reads them. Also writes the daily kpi_snapshots.
 */
export class KpiDigestService {
  constructor(private readonly d: KpiDigestDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  async build(): Promise<KpiDigest> {
    const now = this.now();
    const today = kyivDay(now);
    const from = dayBefore(today, 36);
    const resources = await this.d.catalog.list();
    const refs = resources.map((r) => r.ref);
    const data = new Map(refs.map((r) => [r, series()]));
    // Spec 024 FR-005: each resource's own series is bucketed by its local day (resource_tz);
    // the network aggregates below (agents' spend, slots, budget) stay on the Kyiv day.
    const { rows: zones } = await this.d.pool.query(`SELECT ref, resource_tz(ref) AS tz FROM unnest($1::text[]) AS ref`, [refs]);
    const tzOf = new Map<string, string>(zones.map((z) => [z.ref as string, z.tz as string]));
    const localToday = (ref: string) => { try { return localDate(now, tzOf.get(ref) ?? 'Europe/Kyiv'); } catch { return today; } };

    const { rows: posts } = await this.d.pool.query(
      `SELECT resource_ref, (posted_at AT TIME ZONE resource_tz(resource_ref))::date::text AS day, COUNT(*)::int AS n,
              AVG(views)::float8 AS avg_views, SUM(engagement)::float8 AS eng, SUM(views)::float8 AS views
         FROM network_posts
        WHERE resource_ref = ANY($1::text[]) AND (posted_at AT TIME ZONE resource_tz(resource_ref))::date >= $2::date
        GROUP BY 1, 2`, [refs, from]);
    for (const r of posts) {
      const s = data.get(r.resource_ref);
      if (!s) continue;
      s.posts.set(r.day, Number(r.n));
      if (r.avg_views != null) s.viewsPerPost.set(r.day, Number(r.avg_views));
      if (r.views && Number(r.views) > 0) s.engagementRate.set(r.day, (Number(r.eng ?? 0) / Number(r.views)) * 100);
    }
    const { rows: followers } = await this.d.pool.query(
      `SELECT resource_ref, day::text AS day, followers_delta FROM resource_daily_stats
        WHERE resource_ref = ANY($1::text[]) AND day >= $2::date AND followers_delta IS NOT NULL`, [refs, from]);
    for (const r of followers) data.get(r.resource_ref)?.followerDelta.set(r.day, Number(r.followers_delta));
    const { rows: revenue } = await this.d.pool.query(
      `SELECT 'telegram:' || channel_id AS ref, (paid_at AT TIME ZONE resource_tz('telegram:' || channel_id))::date::text AS day, SUM(amount)::float8 AS uah
         FROM ad_orders WHERE paid_at IS NOT NULL AND (paid_at AT TIME ZONE resource_tz('telegram:' || channel_id))::date >= $1::date
          AND status NOT IN ('canceled','refunded','failed') GROUP BY 1, 2`, [from]).catch(() => ({ rows: [] as any[] }));
    for (const r of revenue) data.get(r.ref)?.revenue.set(r.day, Number(r.uah));
    const { rows: hasJoins } = await this.d.pool.query(`SELECT to_regclass('public.link_joins') IS NOT NULL AS ok`);
    if (hasJoins[0]?.ok) {
      const { rows: joins } = await this.d.pool.query(
        `SELECT l.target_ref AS ref, (j.joined_at AT TIME ZONE resource_tz(l.target_ref))::date::text AS day, SUM(j.count)::int AS n
           FROM link_joins j JOIN tracked_links l ON l.id = j.link_id
          WHERE (j.joined_at AT TIME ZONE resource_tz(l.target_ref))::date >= $1::date GROUP BY 1, 2`, [from]);
      for (const r of joins) data.get(r.ref)?.joins.set(r.day, Number(r.n));
    }

    const { rows: health } = await this.d.pool.query(
      `SELECT resource_ref, resource_health->>'state' AS state FROM resource_profiles WHERE resource_ref = ANY($1::text[])`, [refs]);
    const healthOf = new Map(health.map((h) => [h.resource_ref, h.state as string | null]));

    // Spec 034 FR-006: what the agents wrote and how the critic and the owner judged it (best effort: a failure
    // leaves the KPI digest intact with quality null).
    const quality = await (this.d.quality ?? new SqlQuality(this.d.pool)).digest(refs, now).catch(() => null);

    const raw = new Map<string, ScopeKpis>();
    const out: ResourceDigest[] = resources.map((r) => {
      const k = computeKpis(data.get(r.ref)!, localToday(r.ref));
      raw.set(r.ref, k);
      return {
        // Spec 037 FR-013: views/engagement of a small 7-day sample carry "(n=3, low confidence)".
        ref: r.ref, title: r.title, agent: r.agent, health: healthOf.get(r.ref) ?? null,
        kpis: markSampleConfidence(compactKpis(k), k.posts.value7d, k.views_per_post.value7d),
        anomalies: Object.entries(k).filter(([, m]) => m.anomaly).map(([n]) => n),
        quality: quality?.get(r.ref) ?? null,
      };
    }).sort((a, b) => b.anomalies.length - a.anomalies.length || a.ref.localeCompare(b.ref));

    const { rows: ag } = await this.d.pool.query(
      `SELECT a.id, a.handle, a.mode, a.status, a.paused_until, a.scope_id,
              COALESCE((SELECT SUM(u.cost_usd) FROM llm_usage u WHERE u.root_agent_id = a.id
                         AND u.at >= ($1::date::timestamp AT TIME ZONE 'Europe/Kyiv')
                         AND u.at < (($1::date + 1)::timestamp AT TIME ZONE 'Europe/Kyiv')), 0)::float8 AS spent
         FROM agents a WHERE a.parent_id IS NULL AND a.kind = 'orchestrator' ORDER BY a.handle`, [today]);
    const { rows: slots } = await this.d.pool.query(
      `SELECT 'telegram:' || p.channel_key AS ref, s.status, COUNT(*)::int AS n FROM editor_slots s JOIN editor_plans p ON p.id = s.plan_id
        WHERE p.plan_date = $1::date AND p.status = 'active' GROUP BY 1, 2`, [today]);
    const agents = ag.map((a) => {
      const st: Record<string, number> = {};
      for (const s of slots) if (s.ref === a.scope_id) st[s.status] = s.n;
      return {
        handle: a.handle, mode: a.mode, paused: a.status === 'paused' || (!!a.paused_until && new Date(a.paused_until) > now),
        slotsToday: st, spentTodayUsd: Math.round(Number(a.spent) * 10000) / 10000,
      };
    });
    const { rows: spend } = await this.d.pool.query(
      `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS usd FROM llm_usage
        WHERE feature LIKE 'editor.%' AND feature <> 'editor.chat' AND feature NOT LIKE 'editor.chat.%'
          AND at >= ($1::date::timestamp AT TIME ZONE 'Europe/Kyiv') AND at < (($1::date + 1)::timestamp AT TIME ZONE 'Europe/Kyiv')`, [today]);
    // The spend ledger (spec 029) is the source; the cap is the agents' llm_budgets row.
    const capUsd = this.d.capUsd ? await this.d.capUsd().catch(() => this.d.globalCapUsd) : this.d.globalCapUsd;

    const { rows: open } = await this.d.pool.query(
      `SELECT d.id, a.handle AS to_handle, d.kind, d.status, d.body, d.created_at FROM agent_directives d JOIN agents a ON a.id = d.to_agent_id
        WHERE d.status IN ('new','awaiting_owner','contested','accepted','applied') AND NOT d.shadow ORDER BY d.created_at DESC LIMIT 20`);
    const { rows: outcomes } = await this.d.pool.query(
      `SELECT a.handle AS to_handle, d.kind, d.outcome, d.body, d.outcome_detail FROM agent_directives d JOIN agents a ON a.id = d.to_agent_id
        WHERE d.status IN ('evaluated','rejected','expired') ORDER BY d.updated_at DESC LIMIT 30`);

    const digest: Omit<KpiDigest, 'hash' | 'raw'> = {
      generatedAt: now.toISOString(), today, resources: out, agents,
      budget: { spentTodayUsd: Math.round(Number(spend[0]?.usd ?? 0) * 10000) / 10000, capUsd },
      directives: {
        open: open.map((o) => ({ id: o.id, to: o.to_handle, kind: o.kind, status: o.status, body: String(o.body).slice(0, 200), createdAt: new Date(o.created_at).toISOString() })),
        outcomes: outcomes.map((o) => ({ to: o.to_handle, kind: o.kind, outcome: o.outcome ?? null, body: String(o.body).slice(0, 160), detail: o.outcome_detail ?? null })),
      },
      compliance: await complianceOf(this.d.pool),
    };
    return { ...digest, hash: digestHash(digest), raw };
  }

  /**
   * Prompt text under DIGEST_LIMIT_CHARS: anomalies and quality flags first. When it does not fit: the sample
   * texts of resources without quality flags go first, then every resource keeps at most one short sample, then
   * quiet resources (no anomaly, no quality flag) lose their detail, then the text is cut.
   */
  render(d: KpiDigest): string {
    return renderDigest(d);
  }

  /** Daily snapshot per resource (kpi_snapshots); idempotent per day. */
  async snapshot(d: KpiDigest): Promise<number> {
    let n = 0;
    for (const r of d.resources) {
      await this.d.pool.query(
        `INSERT INTO kpi_snapshots (scope, scope_id, day, metrics) VALUES ('resource', $1, $2::date, $3)
         ON CONFLICT (scope, scope_id, day) DO UPDATE SET metrics = EXCLUDED.metrics`, [r.ref, d.today, JSON.stringify(r.kpis)]);
      n++;
    }
    return n;
  }
}
