import type { Pool } from 'pg';
import { CRITIC_SCORE_KEYS, type CriticScoreKey } from '../critic/critic';
import { audienceCapsOfProfile, isPollFormat, readerQuestions, type AudienceCaps } from '../post/audience-asks';
import { htmlToPlain } from '../post/inline-markup';
import { localDate, localHour } from '../roles/time';
import { addSkip, isNotAMiss, isOwnerDecision, skipGroupOf, type SkipCounts } from '../silent/skip-reasons';
import { DARK_DAY_HOUR } from '../silent/silent-days';
import type { SlotFallback } from '../silent/fallback-ladder';
import { SqlFeedFit, type FeedFit } from './feed-fit';
import { PostAuditService, type AuditSummary } from '../audit/post-audit.service';
import { AUDIT_FLAGS } from '../audit/code-catalogue';
import { REPOST_COUNTS_SQL, repostShare, type RepostShare } from '../story/repost-stats';
import { StoryEventRepository } from '../story/story-event.repository';
import type { EventGap } from '../story/story-event';
import { tierShare, type TierShare } from '../../data/source-tier';

/**
 * Spec 034 FR-006 (T4): the content-quality block of the MANAGER's digest, per resource over 7 days. Code computes
 * every number from the stored data — the critic's verdicts on the slots (T2), the poll/quiz slots and the reader
 * questions against the resource's caps (T3), the owner's rejections and edits in approval mode (spec 031, with
 * the reasons and the before/after notes from the channel memory) and three sample texts — so the MANAGER sees
 * what the agents actually wrote, not only KPI numbers. Every list is short and every text clipped (bounded).
 */

export const QUALITY_DAYS = 7;
export const SAMPLE_CHARS = 400;
export const NOTE_CHARS = 200;
export const REASON_CHARS = 160;
export const MAX_SAMPLES = 3;
export const MAX_NOTES = 3;
/** Fewer critic verdicts than this: no pass-rate flag (too few to judge). */
export const MIN_VERDICTS_FOR_RATE = 3;
/** Pass rate below this (with enough verdicts) is a quality flag. */
export const LOW_PASS_RATE = 0.7;

/** Quality metrics a voice_fix / format_mix directive can name in `expected` (values in %). */
export const QUALITY_METRICS = ['critic_pass_rate', 'owner_rejection_rate', 'poll_share'] as const;
export type QualityMetric = typeof QUALITY_METRICS[number];
export const isQualityMetric = (m: string): m is QualityMetric => (QUALITY_METRICS as readonly string[]).includes(m);

/** Code flags of a resource's quality block (English codes; the dashboard and the quality_check read them). */
export const QUALITY_FLAGS = [
  'critic_reject', 'critic_low_pass', 'critic_failed', 'polls_over_cap', 'reader_questions_over_cap', 'owner_rejections', 'owner_edits',
  // Spec 037 FR-010: a planned day with nothing out (by 18:00 local for today), a series / fixed slot that did not go out.
  'dark_day', 'series_missed',
  // Spec 037 FR-009: a feed whose items mostly carry jargon over the audience level or get a critic revise / reject.
  'feed_misfit',
  // Spec 037 FR-014: the post audit found story repeats, fact / source issues, date, text-hygiene or style findings.
  'story_repeat', 'fact_conflict', 'date_issue', 'text_hygiene', 'style_violation',
  // Spec 037 T2: reposts are more than 30 % of what the resource put out.
  'repost_share_high',
  // Spec 037 T3: the resource announced an event and posted nothing about it within 24 h after it.
  'event_not_covered',
] as const;
export type QualityFlag = typeof QUALITY_FLAGS[number];

export interface QualitySample { at: string; status: string; format: string; text: string }

/** Spec 037 FR-010: one local day of a resource's plan — what was planned, what went out and why the rest did not. */
export interface PlanDay {
  day:          string;
  /** Content slots of the day (superseded plans, mode changes and canceled drafts are not counted). */
  planned:      number;
  published:    number;
  shadowed:     number;
  /** Still planned / being written / waiting for the owner. */
  pending:      number;
  /** Skipped, failed or expired, grouped: critic, lint, cap, nothing_fresh, budget, other. */
  skip_reasons: SkipCounts;
  /** Slots the fallback ladder got out after a failed first post. */
  rescued:      number;
}

export interface PlanBlock {
  days:          PlanDay[];
  /** Days with >= 1 planned slot and nothing out (today only from 18:00 local). */
  dark_days:     string[];
  /** Series / fixed (owner pin) slots that did not go out, newest first (<= 3). */
  series_missed: Array<{ day: string; slot_id: string; series: string; status: string; reason: string }>;
  /** Slots that climbed the fallback ladder in the window, and how many of them went out. */
  fallback:      { laddered: number; rescued: number };
}

export interface ResourceQuality {
  days:    number;
  /** Written posts in the window (published, shadowed, waiting for or approved by the owner). */
  posts:   number;
  critic: {
    pass: number; revise: number; reject: number; failed: number; total: number;
    /** Passed after one rewrite (pass 2 with a revise in its history). */
    revised_then_passed: number;
    /** pass / (pass + revise + reject); null without verdicts. */
    pass_rate: number | null;
    /** Mean score per axis (1–5, one decimal) over the verdicts with scores; null without them. */
    mean: Partial<Record<CriticScoreKey, number>> | null;
    /** The newest notes of non-pass verdicts (≤ 3, clipped). */
    notes: string[];
  };
  polls: { count: number; slots: number; share: number | null; cap: number | null; over: boolean };
  reader_questions: { cap: number; with_questions: number; over_cap: number; examples: string[] };
  owner: { approved: number; edited: number; rejected: number; rejection_rate: number | null; reasons: string[]; edits: string[] };
  samples: QualitySample[];
  /** Spec 037 FR-010: planned vs out per local day with the skip reasons (absent when the plan rows were not read). */
  plan?:   PlanBlock;
  /** Spec 037 FR-009: per feed, the share of items with jargon over the level / critic revise / reject (digest only). */
  feeds?:  FeedFit[];
  /** Spec 037 FR-014: the post audit of the window — findings per digest flag and the top codes (absent before the first audit). */
  audit?:  AuditSummary;
  /** Spec 037 T2: own vs repost publications of a Telegram channel in the window (absent when not read). */
  reposts?: RepostShare;
  /** Spec 037 T3: events the resource announced with no post within 24 h after them (absent when none). */
  events_not_covered?: EventNotCovered[];
  /**
   * Spec 037 T4: the written posts' sources by tier (primary / media / aggregator / low / unknown) and the most cited
   * domains — a resource that lives on one aggregator shows here (absent without a sourced post).
   */
  sources?: TierShare;
  flags:   QualityFlag[];
  /**
   * What changed since the last run (the digest hash reads it): the newest critic issue and owner decision, the
   * flags, and (spec 037) the newest dark day / missed series slot — a new silent day is never a skipped run.
   */
  signature: { issue: string | null; owner: string | null; flags: QualityFlag[]; silent?: string | null };
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const round1 = (x: number) => Math.round(x * 10) / 10;
const ratio = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);

/** The reader-visible text of a written slot: the post spec's caption / blocks, else the rendered preview. */
export function slotText(spec: any, preview: string | null | undefined): string {
  if (spec && typeof spec.caption === 'string' && spec.caption.trim()) {
    const slides = Array.isArray(spec.slides) ? spec.slides.map((s: any) => [s?.title, s?.text].filter(Boolean).join(': ')).filter(Boolean) : [];
    return [spec.caption, ...slides].join('\n');
  }
  if (spec && Array.isArray(spec.body)) {
    const parts: string[] = [];
    for (const b of spec.body) {
      if (typeof b?.text === 'string') parts.push(b.text);
      else if (Array.isArray(b?.items)) parts.push(...b.items.map((x: unknown) => String(x)));
    }
    const t = parts.join('\n').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*([^*]+?)\*\*/g, '$1').trim();
    if (t) return t;
  }
  const p = String(preview ?? '');
  return p.startsWith('↪️') ? '' : htmlToPlain(p).trim();
}

// ── pure assembly ────────────────────────────────────────────────────────────

export interface CriticRow { slotId: string; at: Date; critic: any }
export interface PostRow { slotId: string; at: Date; status: string; format: string; text: string; written: boolean; sourceUrl?: string | null }
export interface OwnerRow { slotId: string; at: Date; outcome: 'clean' | 'edited' | 'rejected'; reason: string | null; edit: string | null }
/** Spec 037 FR-010: one content slot of the window, any status (planned vs out). */
export interface PlanRow {
  slotId: string; at: Date; status: string; error: string | null; criticVerdict: string | null;
  seriesName: string | null; scheduleRuleId: string | null; fallback: SlotFallback | null;
}

export const MAX_SERIES_MISSED = 3;
const PENDING = new Set(['planned', 'running', 'awaiting_approval', 'approved']);

/** Planned vs out per local day, the dark days and the missed series slots of one resource (pure). */
export function assemblePlan(rows: PlanRow[], tz: string, now: Date): PlanBlock {
  const today = localDate(now, tz);
  const afterDark = localHour(now, tz) >= DARK_DAY_HOUR;
  const days = new Map<string, PlanDay>();
  const missed: Array<PlanRow & { day: string }> = [];
  let laddered = 0; let rescued = 0;
  for (const r of rows) {
    if (isNotAMiss(r.error)) continue;
    const day = localDate(r.at, tz);
    if (day > today) continue;
    const d = days.get(day) ?? { day, planned: 0, published: 0, shadowed: 0, pending: 0, skip_reasons: {}, rescued: 0 };
    d.planned++;
    if (r.status === 'published') d.published++;
    else if (r.status === 'shadowed') d.shadowed++;
    else if (PENDING.has(r.status)) d.pending++;
    else {
      addSkip(d.skip_reasons, skipGroupOf(r.error, r.criticVerdict));
      if ((r.seriesName || r.scheduleRuleId) && !isOwnerDecision(r.error)) missed.push({ ...r, day });
    }
    if (r.fallback?.steps?.length) {
      laddered++;
      if (r.fallback.final?.outcome === 'rescued') { rescued++; d.rescued++; }
    }
    days.set(day, d);
  }
  const list = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
  const dark = list.filter((d) => d.published + d.shadowed === 0 && (d.day < today || afterDark)).map((d) => d.day);
  missed.sort((a, b) => b.at.getTime() - a.at.getTime());
  return {
    days: list,
    dark_days: dark,
    series_missed: missed.slice(0, MAX_SERIES_MISSED).map((m) => ({
      day: m.day, slot_id: m.slotId, series: m.seriesName ?? 'fixed slot', status: m.status, reason: clip(m.error ?? 'no reason recorded', REASON_CHARS),
    })),
    fallback: { laddered, rescued },
  };
}

const WRITTEN = new Set(['published', 'shadowed', 'awaiting_approval', 'approved']);
export const isWritten = (status: string) => WRITTEN.has(status);

/** One resource's quality block from its rows (newest first in each list); `plan` adds planned vs out (spec 037). */
export function assembleQuality(i: {
  critic: CriticRow[]; posts: PostRow[]; owner: OwnerRow[]; caps: AudienceCaps; plan?: { rows: PlanRow[]; tz: string; now: Date } | null;
  reposts?: { own: number; reposts: number } | null;
}): ResourceQuality {
  const critic = [...i.critic].sort((a, b) => b.at.getTime() - a.at.getTime());
  const count = (v: string) => critic.filter((c) => c.critic?.verdict === v).length;
  const pass = count('pass'); const revise = count('revise'); const reject = count('reject'); const failed = count('error');
  const judged = pass + revise + reject;
  const sums: Partial<Record<CriticScoreKey, { s: number; n: number }>> = {};
  for (const c of critic) {
    const sc = c.critic?.scores;
    if (!sc || typeof sc !== 'object') continue;
    for (const k of CRITIC_SCORE_KEYS) {
      const v = Number(sc[k]);
      if (!Number.isFinite(v)) continue;
      const e = sums[k] ?? { s: 0, n: 0 };
      e.s += v; e.n++;
      sums[k] = e;
    }
  }
  const mean = Object.keys(sums).length
    ? Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, round1(v!.s / v!.n)])) as Partial<Record<CriticScoreKey, number>>
    : null;
  const notes: string[] = [];
  for (const c of critic) {
    if (notes.length >= MAX_NOTES) break;
    const v = c.critic?.verdict;
    const firstPass = Array.isArray(c.critic?.history) ? c.critic.history.find((h: any) => h?.verdict && h.verdict !== 'pass') : null;
    const text = v !== 'pass' ? c.critic?.notes || c.critic?.reason : firstPass?.notes;
    if (typeof text === 'string' && text.trim()) notes.push(clip(`${v === 'pass' ? 'revise→pass' : v}: ${text}`, NOTE_CHARS));
  }
  const revisedThenPassed = critic.filter((c) => c.critic?.verdict === 'pass' && Array.isArray(c.critic?.history) && c.critic.history.some((h: any) => h?.verdict === 'revise')).length;

  const posts = [...i.posts].sort((a, b) => b.at.getTime() - a.at.getTime());
  const written = posts.filter((p) => p.written);
  const pollCount = posts.filter((p) => isPollFormat(p.format)).length;
  const pollsOver = i.caps.pollsPerWeek != null && pollCount > i.caps.pollsPerWeek;
  let withQ = 0; let overQ = 0; const qExamples: string[] = [];
  for (const p of written) {
    const qs = readerQuestions(p.text);
    if (qs.length) withQ++;
    if (qs.length > i.caps.questionsPerDay) {
      overQ++;
      if (qExamples.length < 2) qExamples.push(clip(qs.join(' '), REASON_CHARS));
    }
  }

  const owner = [...i.owner].sort((a, b) => b.at.getTime() - a.at.getTime());
  const rejected = owner.filter((o) => o.outcome === 'rejected');
  const edited = owner.filter((o) => o.outcome === 'edited');
  const approved = owner.filter((o) => o.outcome !== 'rejected').length;
  const reasons = rejected.map((o) => clip(o.reason?.trim() || '(без причини)', REASON_CHARS)).slice(0, MAX_NOTES);
  const edits = edited.map((o) => clip(o.edit?.trim() || 'власник відредагував (без нотатки)', NOTE_CHARS)).slice(0, MAX_NOTES);

  const flags: QualityFlag[] = [];
  if (reject > 0) flags.push('critic_reject');
  if (judged >= MIN_VERDICTS_FOR_RATE && pass / judged < LOW_PASS_RATE) flags.push('critic_low_pass');
  if (failed > 0) flags.push('critic_failed');
  if (pollsOver) flags.push('polls_over_cap');
  if (overQ > 0) flags.push('reader_questions_over_cap');
  if (rejected.length) flags.push('owner_rejections');
  if (edited.length) flags.push('owner_edits');
  const plan = i.plan ? assemblePlan(i.plan.rows, i.plan.tz, i.plan.now) : undefined;
  if (plan?.dark_days.length) flags.push('dark_day');
  if (plan?.series_missed.length) flags.push('series_missed');
  const reposts = i.reposts ? repostShare(i.reposts.own, i.reposts.reposts) : undefined;
  const sources = written.some((p) => p.sourceUrl) ? tierShare(written.map((p) => p.sourceUrl)) : undefined;
  if (reposts?.over) flags.push('repost_share_high');

  const issue = critic.find((c) => c.critic?.verdict && c.critic.verdict !== 'pass');
  const lastOwner = owner.find((o) => o.outcome !== 'clean');
  const silent = plan && (plan.dark_days.length || plan.series_missed.length)
    ? `${plan.dark_days.at(-1) ?? ''}|${plan.series_missed[0]?.slot_id ?? ''}`
    : null;
  return {
    days: QUALITY_DAYS,
    posts: written.length,
    critic: { pass, revise, reject, failed, total: critic.length, revised_then_passed: revisedThenPassed, pass_rate: ratio(pass, judged), mean, notes },
    polls: { count: pollCount, slots: posts.length, share: ratio(pollCount, posts.length), cap: i.caps.pollsPerWeek, over: pollsOver },
    reader_questions: { cap: i.caps.questionsPerDay, with_questions: withQ, over_cap: overQ, examples: qExamples },
    owner: { approved, edited: edited.length, rejected: rejected.length, rejection_rate: ratio(rejected.length, approved + rejected.length), reasons, edits },
    samples: written.slice(0, MAX_SAMPLES).map((p) => ({ at: p.at.toISOString(), status: p.status, format: p.format, text: clip(p.text, SAMPLE_CHARS) })),
    ...(plan ? { plan } : {}),
    ...(reposts ? { reposts } : {}),
    ...(sources ? { sources } : {}),
    flags,
    signature: {
      issue: issue ? `${issue.slotId}:${issue.critic.verdict}` : null, owner: lastOwner ? `${lastOwner.slotId}:${lastOwner.outcome}` : null, flags,
      ...(silent ? { silent } : {}),
    },
  };
}

/** Spec 037 FR-009: the feed-fit block on a resource's quality, and `feed_misfit` when a feed is to be limited / replaced. */
export function withFeeds(q: ResourceQuality, feeds: FeedFit[] | undefined): ResourceQuality {
  if (!feeds?.length) return q;
  // The flags array is shared with the signature, so a new misfit feed changes the digest hash too.
  if (feeds.some((f) => f.suggestion) && !q.flags.includes('feed_misfit')) q.flags.push('feed_misfit');
  return { ...q, feeds };
}

/** Spec 037 FR-014: the post-audit block on a resource's quality, and a flag per audit group with findings. */
export function withAudit(q: ResourceQuality, audit: AuditSummary | undefined): ResourceQuality {
  if (!audit) return q;
  // The flags array is shared with the signature, so a new audit flag changes the digest hash too.
  for (const f of AUDIT_FLAGS) if ((audit.groups[f] ?? 0) > 0 && !q.flags.includes(f)) q.flags.push(f);
  return { ...q, audit };
}

/** Spec 037 T3: one announced event without a recap, as the digest shows it. */
export interface EventNotCovered { story_key: string; event: string; at: string; all_day: boolean; announced: number }

export const MAX_EVENTS_NOT_COVERED = 5;

/** Spec 037 T3: the uncovered events on a resource's quality, and the `event_not_covered` flag. */
export function withEvents(q: ResourceQuality, gaps: EventGap[] | undefined): ResourceQuality {
  if (!gaps?.length) return q;
  // The flags array is shared with the signature, so a new uncovered event changes the digest hash too.
  if (!q.flags.includes('event_not_covered')) q.flags.push('event_not_covered');
  const events = gaps.slice(-MAX_EVENTS_NOT_COVERED).map((g) => ({
    story_key: g.key, event: clip(g.event.name || g.title, 90), at: g.event.at, all_day: g.event.allDay, announced: g.resources[0]?.announced ?? 0,
  }));
  return { ...q, events_not_covered: events };
}

/** Has the resource produced anything to judge in the window (posts, verdicts or owner decisions)? */
export function qualityActive(q: ResourceQuality | null | undefined): boolean {
  return !!q && (q.posts > 0 || q.critic.total > 0 || q.owner.approved + q.owner.rejected > 0 || q.polls.slots > 0
    || (q.plan?.days.some((d) => d.planned > 0) ?? false));
}

/** A quality metric's value in % (null without data). */
export function qualityMetricValue(q: ResourceQuality | null | undefined, metric: string): number | null {
  if (!q) return null;
  const pct = (x: number | null) => (x == null ? null : round1(x * 100));
  switch (metric) {
    case 'critic_pass_rate':     return pct(q.critic.pass_rate);
    case 'owner_rejection_rate': return pct(q.owner.rejection_rate);
    case 'poll_share':           return pct(q.polls.share);
    default:                     return null;
  }
}

/** The quality part of the digest hash: a new critic issue, a new owner rejection/edit or a new flag changes it. */
export function qualitySignature(rows: Array<{ ref: string; quality?: ResourceQuality | null }>): Array<[string, unknown]> {
  return rows.filter((r) => r.quality).map((r) => [r.ref, r.quality!.signature]);
}

/** The prompt-size variant of a block: no samples, shorter lists (used when the digest does not fit). */
export function slimQuality(q: ResourceQuality, o: { samples: number; sampleChars: number }): ResourceQuality {
  return { ...q, samples: q.samples.slice(0, o.samples).map((s) => ({ ...s, text: clip(s.text, o.sampleChars) })) };
}

// ── SQL ──────────────────────────────────────────────────────────────────────

const REF = `COALESCE(s.resource_ref, 'telegram:' || s.channel_key)`;

/** The quality data of resources: the digest block (7 days) and the windows a directive's verification compares. */
export class SqlQuality {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async rows(refs: string[], from: Date, to: Date): Promise<Map<string, { critic: CriticRow[]; posts: PostRow[]; owner: OwnerRow[]; plan: PlanRow[]; tz: string; reposts?: { own: number; reposts: number } }>> {
    const out = new Map(refs.map((r) => [r, { critic: [] as CriticRow[], posts: [] as PostRow[], owner: [] as OwnerRow[], plan: [] as PlanRow[], tz: 'Europe/Kyiv' } as {
      critic: CriticRow[]; posts: PostRow[]; owner: OwnerRow[]; plan: PlanRow[]; tz: string; reposts?: { own: number; reposts: number };
    }]));
    if (!refs.length) return out;
    // Spec 037 T2: own vs repost publications of the Telegram channels (best-effort: the block works without it).
    const tg = refs.filter((r) => r.startsWith('telegram:'));
    if (tg.length) {
      const { rows: rp } = await this.pool.query(REPOST_COUNTS_SQL, [tg, from, to]).catch(() => ({ rows: [] as any[] }));
      for (const r of rp ?? []) { const e = out.get(r.ref); if (e) e.reposts = { own: Number(r.own ?? 0), reposts: Number(r.reposts ?? 0) }; }
      for (const r of tg) { const e = out.get(r)!; e.reposts ??= { own: 0, reposts: 0 }; }
    }
    // Spec 037 FR-010: every content slot of the window (planned vs out, skip reasons) and each resource's zone.
    const { rows: plan } = await this.pool.query(
      `SELECT ${REF} AS ref, s.id::text AS id, s.scheduled_at AS at, s.status, s.error, s.critic->>'verdict' AS verdict,
              s.series_name, s.schedule_rule_id::text AS schedule_rule_id, s.fallback
         FROM editor_slots s
        WHERE s.kind = 'content' AND ${REF} = ANY($1::text[]) AND s.scheduled_at >= $2 AND s.scheduled_at < $3
        ORDER BY s.scheduled_at LIMIT 5000`, [refs, from, to]);
    for (const r of plan) {
      out.get(r.ref)?.plan.push({
        slotId: r.id, at: new Date(r.at), status: r.status, error: r.error ?? null, criticVerdict: r.verdict ?? null,
        seriesName: r.series_name ?? null, scheduleRuleId: r.schedule_rule_id ?? null, fallback: r.fallback ?? null,
      });
    }
    const { rows: zones } = await this.pool.query(`SELECT ref, resource_tz(ref) AS tz FROM unnest($1::text[]) AS ref`, [refs]);
    for (const z of zones) { const e = out.get(z.ref); if (e && z.tz) e.tz = z.tz; }
    const { rows: critic } = await this.pool.query(
      `SELECT ${REF} AS ref, s.id::text AS id, s.updated_at AS at, s.critic
         FROM editor_slots s
        WHERE s.critic IS NOT NULL AND s.kind = 'content' AND ${REF} = ANY($1::text[]) AND s.updated_at >= $2 AND s.updated_at < $3
        ORDER BY s.updated_at DESC LIMIT 3000`, [refs, from, to]);
    for (const r of critic) out.get(r.ref)?.critic.push({ slotId: r.id, at: new Date(r.at), critic: r.critic });
    // Posts of the window: polls count every live slot (planned ones too); texts only the written ones.
    const { rows: posts } = await this.pool.query(
      `SELECT ${REF} AS ref, s.id::text AS id, s.status, s.format, s.scheduled_at AS at, s.post_spec, s.rendered_preview,
              COALESCE(s.post_spec->'source'->>'url', s.platform_spec->'source'->>'url') AS source_url
         FROM editor_slots s
        WHERE s.kind = 'content' AND ${REF} = ANY($1::text[]) AND s.scheduled_at >= $2 AND s.scheduled_at < $3
          AND s.status NOT IN ('skipped','failed','expired')
        ORDER BY s.scheduled_at DESC LIMIT 3000`, [refs, from, new Date(to.getTime() + 2 * 86_400_000)]);
    for (const r of posts) {
      const written = isWritten(r.status);
      out.get(r.ref)?.posts.push({ slotId: r.id, at: new Date(r.at), status: r.status, format: r.format, written, text: written ? slotText(r.post_spec, r.rendered_preview) : '', sourceUrl: written ? r.source_url ?? null : null });
    }
    const { rows: owner } = await this.pool.query(
      `SELECT ${REF} AS ref, s.id::text AS id, COALESCE(s.approved_at, s.updated_at) AS at,
              CASE WHEN s.approved_at IS NOT NULL THEN CASE WHEN s.owner_edited THEN 'edited' ELSE 'clean' END ELSE 'rejected' END AS outcome,
              s.reject_reason, e.text AS edit
         FROM editor_slots s
         LEFT JOIN LATERAL (
           SELECT m.text FROM editor_channel_memory m
            WHERE m.channel_key = s.channel_key AND m.evidence->>'slotId' = s.id::text AND m.evidence->>'action' = 'edit'
            ORDER BY m.created_at DESC LIMIT 1) e ON true
        WHERE ${REF} = ANY($1::text[])
          AND (s.approved_at IS NOT NULL OR (s.status = 'skipped' AND s.error = 'rejected by owner'))
          AND COALESCE(s.approved_at, s.updated_at) >= $2 AND COALESCE(s.approved_at, s.updated_at) < $3
        ORDER BY 3 DESC LIMIT 3000`, [refs, from, to]);
    for (const r of owner) out.get(r.ref)?.owner.push({ slotId: r.id, at: new Date(r.at), outcome: r.outcome, reason: r.reject_reason ?? null, edit: r.edit ?? null });
    return out;
  }

  /** resource_ref → effective audience caps (defaults without a profile). */
  async caps(refs: string[]): Promise<Map<string, AudienceCaps>> {
    const { rows } = refs.length
      ? await this.pool.query(`SELECT resource_ref, profile FROM resource_profiles WHERE resource_ref = ANY($1::text[])`, [refs])
      : { rows: [] as any[] };
    return new Map(refs.map((r) => [r, audienceCapsOfProfile(rows.find((x) => x.resource_ref === r)?.profile ?? null)]));
  }

  /** resource_ref → effective caps and the owner-locked format fields (format_mix plans against them). */
  async audience(refs: string[]): Promise<Record<string, { caps: AudienceCaps; locks: string[] }>> {
    const { rows } = refs.length
      ? await this.pool.query(`SELECT resource_ref, profile FROM resource_profiles WHERE resource_ref = ANY($1::text[])`, [refs])
      : { rows: [] as any[] };
    return Object.fromEntries(refs.map((r) => {
      const profile = rows.find((x) => x.resource_ref === r)?.profile ?? null;
      const locks = Array.isArray(profile?.format_locks) ? profile.format_locks.filter((x: unknown): x is string => typeof x === 'string') : [];
      return [r, { caps: audienceCapsOfProfile(profile), locks }];
    }));
  }

  /** The digest block of every resource for the 7 days up to `now`. */
  async digest(refs: string[], now: Date): Promise<Map<string, ResourceQuality>> {
    const from = new Date(now.getTime() - QUALITY_DAYS * 86_400_000);
    // A minute of slack: a row written in the same millisecond (DB clocks are finer) still counts.
    const [data, caps, feeds, audit, events] = await Promise.all([
      this.rows(refs, from, new Date(now.getTime() + 60_000)), this.caps(refs),
      new SqlFeedFit(this.pool).feeds(refs, from, new Date(now.getTime() + 60_000)).catch(() => new Map<string, FeedFit[]>()),
      new PostAuditService({ pool: this.pool }).summaries(refs, now).catch(() => new Map<string, AuditSummary>()),
      new StoryEventRepository(this.pool).gapsByRef(refs, from, now).catch(() => new Map<string, EventGap[]>()),
    ]);
    return new Map(refs.map((r) => {
      const d = data.get(r)!;
      return [r, withEvents(withAudit(withFeeds(assembleQuality({ ...d, caps: caps.get(r)!, plan: { rows: d.plan, tz: d.tz, now } }), feeds.get(r)), audit.get(r)), events.get(r))];
    }));
  }

  /** One resource's quality in [from, to) (voice_fix / format_mix verification). */
  async window(ref: string, from: Date, to: Date): Promise<ResourceQuality> {
    const [data, caps] = await Promise.all([this.rows([ref], from, to), this.caps([ref])]);
    const d = data.get(ref)!;
    return assembleQuality({ ...d, caps: caps.get(ref)!, plan: { rows: d.plan, tz: d.tz, now: to } });
  }

  /**
   * Posts a voice_fix may quote as bad examples: rejected by the owner, or a critic reject / revise, in the last
   * `days` days, with the reason (owner) or the critic's notes. Newest first, ≤ 20 per resource.
   */
  async evidencePosts(refs: string[], since: Date): Promise<EvidencePost[]> {
    if (!refs.length) return [];
    const { rows } = await this.pool.query(
      `SELECT * FROM (
         SELECT ${REF} AS ref, s.id::text AS id, s.format, s.updated_at AS at, s.post_spec, s.rendered_preview, s.reject_reason, s.critic,
                (s.status = 'skipped' AND s.error = 'rejected by owner') AS by_owner,
                row_number() OVER (PARTITION BY ${REF} ORDER BY s.updated_at DESC) AS n
           FROM editor_slots s
          WHERE ${REF} = ANY($1::text[]) AND s.kind = 'content' AND s.updated_at >= $2
            AND ((s.status = 'skipped' AND s.error = 'rejected by owner') OR s.critic->>'verdict' IN ('reject','revise')
                 OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.critic->'history') = 'array' THEN s.critic->'history' ELSE '[]'::jsonb END) h
                             WHERE h->>'verdict' IN ('reject','revise')))
       ) x WHERE n <= 20 ORDER BY at DESC`, [refs, since]);
    return rows.map((r) => {
      const c = r.critic ?? null;
      const firstBad = Array.isArray(c?.history) ? c.history.find((h: any) => h?.verdict === 'revise' || h?.verdict === 'reject') : null;
      const note = r.by_owner
        ? (r.reject_reason?.trim() || 'без причини')
        : (c?.verdict === 'pass' ? firstBad?.notes : c?.notes) || c?.reason || '';
      return {
        slotId: r.id, ref: r.ref, format: r.format, at: new Date(r.at), source: r.by_owner ? 'owner' as const : 'critic' as const,
        note: clip(String(note), 240), text: slotText(r.post_spec, r.rendered_preview).slice(0, 1200),
      };
    }).filter((p) => p.text.length >= 10);
  }
}

/** A real post a voice_fix can quote as a bad example. */
export interface EvidencePost { slotId: string; ref: string; format: string; at: Date; source: 'owner' | 'critic'; note: string; text: string }
