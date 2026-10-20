import { createHash } from 'crypto';
import { localDate } from '../roles/time';
import type { Pool } from 'pg';
import { overruledWarningsOf } from '../critic/overruled';
import { reportCounts } from '../sysadmin/audit-report';
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
  /** perPost7dUsd (spec 046 FR-005): 7-day production spend per published / shadowed post; null without posts or when unread. */
  budget:      { spentTodayUsd: number; capUsd: number; spent7dUsd?: number | null; posts7d?: number | null; perPost7dUsd?: number | null };
  directives:  { open: Array<{ id: string; to: string; kind: string; status: string; body: string; createdAt: string; binding?: string; reviewAt?: string | null }>; outcomes: Array<{ to: string; kind: string; outcome: string | null; body: string; detail: unknown }> };
  /** Spec 025 FR-017: how each orchestrator answered the MANAGER over 30 days. */
  compliance?: ComplianceRow[];
  /** Spec 040 FR-011: where a playbook or profile contradicts the owner's rules (fixed by @ai0's fix_config_conflicts card). */
  config_conflicts?: Array<{ agent: string; ref: string; code: string; detail: string }>;
  /** Spec 041 FR-006: lint warning codes the critic passed over the last 7 days (posts per code, top 8). */
  lint_overruled?: Array<{ code: string; posts: number }>;
  /** Spec 055 FR-004: the newest finished audit of the sysadmin — open findings by severity (one line, no directive kind). */
  audit?: AuditDigestLine;
  hash:        string;
  raw:         Map<string, ScopeKpis>;
}

export interface AuditDigestLine { reportId: string; week: string; at: string; open: number; error: number; warn: number; info: number; fixable: number }

/** Spec 055 FR-004: the newest finished audit as one digest line; null with no report, nothing open or no table. */
export async function auditLineOf(pool: Pick<Pool, 'query'>): Promise<AuditDigestLine | null> {
  try {
    const { rows } = await pool.query(`SELECT id, week, findings, COALESCE(finished_at, started_at) AS at FROM audit_reports WHERE status = 'done' ORDER BY started_at DESC LIMIT 1`);
    const r = rows?.[0];
    if (!r) return null;
    const c = reportCounts(Array.isArray(r.findings) ? r.findings : []);
    if (c.open === 0) return null;
    return { reportId: String(r.id), week: String(r.week), at: new Date(r.at).toISOString(), open: c.open, error: c.error, warn: c.warn, info: c.info, fixable: c.fixable };
  } catch { return null; }
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
  /** Spec 040 FR-011: rules-vs-config conflicts of every orchestrator (agent handle + conflict). */
  conflicts?: () => Promise<Array<{ agent: string; ref: string; code: string; detail: string }>>;
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

/**
 * Spec 040 FR-007: what a manager review reacts to — per resource with an agent, the KPI anomalies and the quality
 * flags (sorted). The same signature as the last review skips the scheduled run (one forced review a day).
 */
export function reviewSignature(d: Pick<KpiDigest, 'resources'> & { directives?: Pick<KpiDigest['directives'], 'open'> }): string {
  // Spec 046 FR-004: quality flags of an agent that already has an open / in-force directive are covered — they no
  // longer force a review (review 2: per-post flag noise meant the skip almost never fired).
  const covered = new Set((d.directives?.open ?? []).map((x) => x.to));
  const rows = d.resources
    .filter((r) => r.agent)
    .map((r) => [r.ref, [...r.anomalies].sort(), covered.has(r.agent!) ? [] : [...(r.quality?.flags ?? [])].sort()] as const)
    .filter(([, a, f]) => a.length || f.length)
    .sort((x, y) => x[0].localeCompare(y[0]));
  return createHash('sha1').update(JSON.stringify(rows)).digest('hex');
}

const flagged = (r: ResourceDigest) => (r.quality?.flags.length ?? 0) > 0;
const loud = (r: ResourceDigest) => r.anomalies.length > 0 || flagged(r);
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const QUIET_NOTE = 'без аномалій і прапорців якості';

/** Spec 046 FR-001: a flagged resource's quality block without the long parts (samples, plan days, feed lists). */
function compactQuality(q: ResourceQuality): Record<string, unknown> {
  const { samples: _s, signature: _g, plan, feeds, reader_questions, owner, critic, events_not_covered, ...rest } = q;
  return {
    ...rest,
    critic: { ...critic, notes: critic.notes.slice(0, 2).map((n) => cut(n, 120)) },
    owner: { ...owner, reasons: owner.reasons.slice(0, 2).map((n) => cut(n, 120)), edits: owner.edits.slice(0, 1).map((n) => cut(n, 120)) },
    reader_questions: { ...reader_questions, examples: [] },
    ...(plan ? { plan: { dark_days: plan.dark_days, series_missed: plan.series_missed, fallback: plan.fallback } } : {}),
    ...(feeds?.length ? { feeds: feeds.slice(0, 3) } : {}),
    ...(events_not_covered?.length ? { events_not_covered: events_not_covered.slice(0, 3) } : {}),
  };
}

/** The smallest quality view that still carries the flags and the numbers a quality_check cites. */
const tinyQuality = (q: ResourceQuality) => ({
  flags: q.flags, posts: q.posts, critic_pass_rate: q.critic.pass_rate, critic: { pass: q.critic.pass, revise: q.critic.revise, reject: q.critic.reject },
  owner_rejection_rate: q.owner.rejection_rate, polls: { count: q.polls.count, cap: q.polls.cap, over: q.polls.over },
});

export interface DigestView {
  /** Valid JSON, at most `limit` characters. */
  text:     string;
  /** Resources whose quality block (at least the flags and the numbers) is in the text — submit_review asks only for these. */
  detailed: Set<string>;
  /** How far the render had to slim (0 = complete). */
  level:    number;
}

/**
 * Spec 046 FR-001: the digest as the MANAGER reads it, always valid JSON under `limit`. The head (budget, config
 * conflicts, directives, agents, compliance) comes before the resources, so slimming never loses it. Steps:
 * quiet samples go → flagged keep one short sample → quiet resources become a stub → flagged blocks lose their long
 * parts and the head its long texts → quality shrinks to flags and numbers, quiet resources to a list of refs →
 * the least anomalous resources are left out (`resources_omitted`; get_kpi_digest({resource}) reads one) → the
 * head keeps only ids. Never a cut string (review 2: a sliced JSON failed every get_kpi_digest call).
 */
export function digestView(d: KpiDigest, limit = DIGEST_LIMIT_CHARS): DigestView {
  type Res = Record<string, unknown> & { ref: string };
  const head = (o: { outcomesBody?: number; openBody?: number; detail?: boolean; reasons?: number; bare?: boolean } = {}) => {
    const dir = d.directives;
    if (o.bare) {
      return {
        budget: d.budget, config_conflicts: d.config_conflicts?.map((c) => ({ agent: c.agent, ref: c.ref, code: c.code })),
        ...(d.audit ? { audit: d.audit } : {}),
        directives: { open: dir.open.map((x) => ({ id: x.id, to: x.to, kind: x.kind, status: x.status })) },
        agents: d.agents.map((a) => ({ handle: a.handle, mode: a.mode, paused: a.paused, spentTodayUsd: a.spentTodayUsd })),
      };
    }
    return {
      budget: d.budget,
      config_conflicts: d.config_conflicts,
      directives: {
        open: o.openBody ? dir.open.map((x) => ({ ...x, body: cut(x.body, o.openBody!) })) : dir.open,
        outcomes: o.outcomesBody
          ? dir.outcomes.map((x) => ({ ...x, body: cut(x.body, o.outcomesBody!), detail: o.detail === false ? undefined : x.detail }))
          : dir.outcomes,
      },
      agents: d.agents,
      compliance: o.reasons == null ? d.compliance : d.compliance?.map((c) => ({ ...c, decline_reasons: c.decline_reasons.slice(0, o.reasons).map((x) => ({ kind: x.kind, reason: cut(x.reason, 100) })) })),
      ...(d.lint_overruled?.length ? { lint_overruled: d.lint_overruled } : {}),
      ...(d.audit ? { audit: d.audit } : {}),
    };
  };
  const doc = (h: object, resources: Res[], extra: Record<string, unknown> = {}) =>
    JSON.stringify({ generatedAt: d.generatedAt, today: d.today, ...h, resources, ...extra });
  const withQ = (r: ResourceDigest, q: unknown): Res => ({ ...r, quality: q } as Res);
  const stub = (r: ResourceDigest): Res => ({ ref: r.ref, agent: r.agent, anomalies: [], note: QUIET_NOTE });
  const short = (r: ResourceDigest): Res => (r.quality ? withQ(r, slimQuality(r.quality, { samples: flagged(r) ? 1 : 0, sampleChars: 200 })) : (r as unknown as Res));
  const noSamples = (r: ResourceDigest): Res => (r.quality && !flagged(r) ? withQ(r, slimQuality(r.quality, { samples: 0, sampleChars: 0 })) : (r as unknown as Res));
  const compact = (r: ResourceDigest): Res => (r.quality ? withQ(r, compactQuality(r.quality)) : (r as unknown as Res));
  const tiny = (r: ResourceDigest): Res => ({ ref: r.ref, agent: r.agent, health: r.health, kpis: r.kpis, anomalies: r.anomalies, quality: r.quality ? tinyQuality(r.quality) : r.quality } as Res);
  const rs = d.resources;
  const loudRows = rs.filter(loud);
  const quietRefs = rs.filter((r) => !loud(r)).map((r) => r.ref);
  const all = new Set(rs.filter((r) => r.quality).map((r) => r.ref));
  const loudSet = new Set(loudRows.filter((r) => r.quality).map((r) => r.ref));

  const steps: Array<() => { text: string; detailed: Set<string> }> = [
    () => ({ text: doc(head(), rs as unknown as Res[]), detailed: all }),
    () => ({ text: doc(head(), rs.map(noSamples)), detailed: all }),
    () => ({ text: doc(head(), rs.map(short)), detailed: all }),
    () => ({ text: doc(head(), rs.map((r) => (loud(r) ? short(r) : stub(r)))), detailed: loudSet }),
    () => ({ text: doc(head({ outcomesBody: 100, openBody: 160, reasons: 1 }), rs.map((r) => (loud(r) ? compact(r) : stub(r)))), detailed: loudSet }),
    () => ({ text: doc(head({ outcomesBody: 80, openBody: 120, detail: false, reasons: 1 }), loudRows.map(tiny), { quiet: quietRefs }), detailed: loudSet }),
  ];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]();
    if (s.text.length <= limit) return { ...s, level: i };
  }
  // Leave out the least anomalous resources (the list is sorted by anomaly count) until it fits.
  const h = head({ outcomesBody: 80, openBody: 120, detail: false, reasons: 1 });
  const hint = 'get_kpi_digest({resource}) — повний блок одного ресурсу';
  for (let n = loudRows.length - 1; n >= 0; n--) {
    const kept = loudRows.slice(0, n);
    const text = doc(h, kept.map(tiny), { quiet: quietRefs, resources_omitted: loudRows.slice(n).map((r) => r.ref), hint });
    if (text.length <= limit) return { text, detailed: new Set(kept.filter((r) => r.quality).map((r) => r.ref)), level: steps.length };
  }
  const refs = rs.map((r) => r.ref);
  const bare = doc(head({ bare: true }), [], { resources_omitted: refs, hint });
  if (bare.length <= limit) return { text: bare, detailed: new Set(), level: steps.length + 1 };
  const min = (omitted: unknown) => JSON.stringify({ generatedAt: d.generatedAt, today: d.today, budget: d.budget, open_directives: d.directives.open.length, resources: [], resources_omitted: omitted, hint });
  const listed = min(refs);
  return { text: listed.length <= limit ? listed : min(refs.length), detailed: new Set(), level: steps.length + 2 };
}

/** See KpiDigestService.render. */
export function renderDigest(d: KpiDigest, limit = DIGEST_LIMIT_CHARS): string {
  return digestView(d, limit).text;
}

/** Spec 046 FR-001: one resource in full (get_kpi_digest({resource})); samples bounded so one block stays readable. */
export function resourceView(d: KpiDigest, ref: string): ResourceDigest | null {
  const r = d.resources.find((x) => x.ref === ref) ?? d.resources.find((x) => x.ref.endsWith(`:${ref}`) || x.ref.endsWith(`:@${ref}`));
  if (!r) return null;
  return r.quality ? { ...r, quality: slimQuality(r.quality, { samples: 3, sampleChars: 600 }) } : r;
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
    const week = await this.costPerPost().catch(() => null);

    const { rows: open } = await this.d.pool.query(
      `SELECT d.id, a.handle AS to_handle, d.kind, d.binding, d.status, d.body, d.created_at, d.review_at FROM agent_directives d JOIN agents a ON a.id = d.to_agent_id
        WHERE d.status IN ('new','awaiting_owner','contested','accepted','applied') AND NOT d.shadow ORDER BY d.created_at DESC LIMIT 20`);
    const { rows: outcomes } = await this.d.pool.query(
      `SELECT a.handle AS to_handle, d.kind, d.outcome, d.body, d.outcome_detail FROM agent_directives d JOIN agents a ON a.id = d.to_agent_id
        WHERE d.status IN ('evaluated','rejected','expired') ORDER BY d.updated_at DESC LIMIT 30`);

    // Spec 040 FR-011: a conflict flags its resource, so it changes the hash and the review signature.
    const conflicts = this.d.conflicts ? await this.d.conflicts().catch(() => []) : [];
    const overruled = await overruledWarningsOf(this.d.pool);
    const audit = await auditLineOf(this.d.pool);
    for (const c of conflicts) {
      const q = out.find((r) => r.ref === c.ref)?.quality;
      if (q && !q.flags.includes('config_conflict')) q.flags.push('config_conflict');
    }

    const digest: Omit<KpiDigest, 'hash' | 'raw'> = {
      generatedAt: now.toISOString(), today, resources: out, agents,
      budget: { spentTodayUsd: Math.round(Number(spend[0]?.usd ?? 0) * 10000) / 10000, capUsd, ...(week ?? {}) },
      directives: {
        open: open.map((o) => ({
          id: o.id, to: o.to_handle, kind: o.kind, status: o.status, body: String(o.body).slice(0, 200), createdAt: new Date(o.created_at).toISOString(),
          binding: o.binding ?? undefined, reviewAt: o.review_at ? new Date(o.review_at).toISOString() : null,
        })),
        outcomes: outcomes.map((o) => ({ to: o.to_handle, kind: o.kind, outcome: o.outcome ?? null, body: String(o.body).slice(0, 160), detail: o.outcome_detail ?? null })),
      },
      compliance: await complianceOf(this.d.pool),
      ...(conflicts.length ? { config_conflicts: conflicts } : {}),
      ...(overruled.length ? { lint_overruled: overruled } : {}),
      ...(audit ? { audit } : {}),
    };
    return { ...digest, hash: digestHash(digest), raw };
  }

  /** Spec 046 FR-005: the agents' production spend of the last 7 days per post that went out (published or shadowed). */
  private async costPerPost(): Promise<{ spent7dUsd: number; posts7d: number; perPost7dUsd: number | null }> {
    const { rows } = await this.d.pool.query(
      `SELECT (SELECT COALESCE(SUM(cost_usd), 0)::float8 FROM llm_usage
                WHERE feature LIKE 'editor.%' AND feature <> 'editor.chat' AND feature NOT LIKE 'editor.chat.%' AND at >= now() - interval '7 days') AS usd,
              (SELECT COUNT(*)::int FROM editor_slots WHERE status IN ('published','shadowed') AND updated_at >= now() - interval '7 days') AS posts`);
    const usd = Number(rows[0]?.usd ?? 0);
    const posts = Number(rows[0]?.posts ?? 0);
    const r4 = (x: number) => Math.round(x * 10000) / 10000;
    return { spent7dUsd: r4(usd), posts7d: posts, perPost7dUsd: posts > 0 ? r4(usd / posts) : null };
  }

  /** Prompt text under DIGEST_LIMIT_CHARS, always valid JSON (see digestView). */
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
