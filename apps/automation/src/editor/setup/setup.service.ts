import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { EditorCard } from '../card';
import type { Agent } from '../agents/agent.types';
import type { AgentLoop, AgentLoopResult } from '../harness/agent-loop';
import type { ModelProfile } from '../llm/model-registry';
import { renderProfile } from '../agents/resource-profile';
import { editorFeature } from '../../common/ai/usage/features';
import { isFloodWait } from '../../common/telegram/flood-wait';
import { validatePlaybook } from '../network/playbook';
import {
  buildSubmitSetupTool, onboarderSystemPrompt, onboarderUserPrompt, SETUP_SECTIONS, SUBMIT_SETUP_TOOL, SubmitSetupInput,
  type SetupSection,
} from './setup-analysis';
import { applySections, driftedSections, formatPatch, mergePlaybook, sectionBaseline, type ApplyWriters, type ChannelState } from './setup-apply';
import { computeMetrics, type ChannelMetrics } from './setup-metrics';
import { trackedChannel, type CollectResult } from './setup-posts';
import { hasPostText, MIN_SPAN_DAYS, MIN_TEXT_POSTS, type SetupPost } from './setup-posts.types';
import type { SetupExpiry } from './setup-expiry';
import type { ChannelSetupRepository, SectionState, SetupProposal } from './setup.repository';

/**
 * Spec 042: channel setup from history. The queue is `channel_setup_proposals` itself: `analyze` queues proposals, one
 * in-process worker takes them one at a time (kicked on enqueue and by the editor's minute tick; a restart loses nothing),
 * collects the posts, computes the metrics, runs the onboarder once and stores the six sections. The owner applies them
 * by section (FR-006).
 */

export const ONBOARDER_MAX_STEPS = 4;
export const ONBOARDER_MAX_COST_USD = 0.3;
export const MAX_CHANNELS_PER_RUN = 50;
/** A proposal stuck in collecting / analyzing this long (a restart mid-run) goes back to the queue. */
const STUCK_MS = 15 * 60_000;

export interface OverviewRow {
  channelKey:     string;
  title:          string | null;
  trackingStatus: string;
  postsStored:    number;
  hasCard:        boolean;
  mode:           string | null;
  hasBrief:       boolean;
  hasProfile:     boolean;
  hasPlaybook:    boolean;
  agentHandle:    string | null;
  latest:         { id: string; status: string; reason: string | null; createdAt: Date; costUsd: number } | null;
}

export interface ChannelSetupDeps {
  pool:     Pick<Pool, 'query'>;
  repo:     ChannelSetupRepository;
  collect:  (channelKey: string) => Promise<CollectResult>;
  loop:     Pick<AgentLoop, 'run'>;
  /** The onboarder's model for the channel (its agent's and the workspace's choices). */
  model:    (agent: Agent | null, card: EditorCard | null) => Promise<ModelProfile>;
  /** The channel's card, agent, profile, locks, active playbook and voice skill now. */
  state:    (channelKey: string) => Promise<ChannelState>;
  writers:  ApplyWriters;
  /** Spec 057: the hourly expiry sweep run from the minute tick (absent = proposals never expire). */
  expiry?:  Pick<SetupExpiry, 'sweep'>;
  now?:     () => Date;
  log?:     (msg: string) => void;
}

const AnalyzeBody = z.object({ channelKeys: z.array(z.string().trim().min(2).max(200)).min(1).max(MAX_CHANNELS_PER_RUN) }).strict();
const ApplyBody = z.object({
  sections: z.array(z.enum(SETUP_SECTIONS)).min(1).max(SETUP_SECTIONS.length),
  // Sections the owner applies although they changed since the analysis: the proposal replaces the newer change.
  override: z.array(z.enum(SETUP_SECTIONS)).max(SETUP_SECTIONS.length).optional(),
}).strict();

export class ChannelSetupService {
  private worker: Promise<void> | null = null;

  constructor(private readonly d: ChannelSetupDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  // ── queue ─────────────────────────────────────────────────────────────────

  async analyze(body: unknown, createdBy = 'owner') {
    const p = AnalyzeBody.safeParse(body ?? {});
    if (!p.success) throw new BadRequestException({ error: 'invalid_body', issues: p.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const queued: SetupProposal[] = [];
    const refused: Array<{ channelKey: string; error: string }> = [];
    for (const key of [...new Set(p.data.channelKeys)]) {
      const ch = await trackedChannel(this.d.pool, key);
      if (!ch || !ch.isMine) { refused.push({ channelKey: key, error: 'not_own_channel' }); continue; }
      queued.push(await this.d.repo.enqueue(key, createdBy));
    }
    this.kick();
    return { queued, refused };
  }

  /** Start the worker when idle (never awaited by callers). */
  kick(): void {
    if (this.worker) return;
    this.worker = this.drain()
      .catch((err) => this.d.log?.(`channel setup worker failed: ${err?.message ?? err}`))
      .finally(() => { this.worker = null; });
  }

  /** Resolves when the worker started by `kick` has drained the queue (tests). */
  async idle(): Promise<void> {
    while (this.worker) await this.worker;
  }

  /** The editor's minute tick: stuck proposals back to the queue, forgotten ones expire (spec 057), then the worker. */
  async tick(): Promise<void> {
    await this.d.repo.requeueStuck(new Date(this.now().getTime() - STUCK_MS)).catch(() => 0);
    await this.d.expiry?.sweep().catch((err) => this.d.log?.(`setup expiry sweep failed: ${err?.message ?? err}`));
    this.kick();
  }

  private async drain(): Promise<void> {
    for (;;) {
      const next = await this.d.repo.claimNext(this.now());
      if (!next) return;
      await this.process(next);
    }
  }

  /** One proposal: posts → metrics → onboarder → sections. Exported for tests through `processNow`. */
  async process(p: SetupProposal): Promise<SetupProposal | null> {
    let collected: CollectResult;
    try {
      collected = await this.d.collect(p.channelKey);
    } catch (err) {
      const wait = isFloodWait(err);
      if (wait !== null) return this.d.repo.update(p.id, { status: 'queued', retryAt: new Date(this.now().getTime() + wait * 1000), reason: `Telegram asked to wait ${wait}s` });
      return this.d.repo.update(p.id, { status: 'failed', reason: `posts: ${String((err as Error)?.message ?? err).slice(0, 300)}` });
    }
    if (collected.status !== 'ok') {
      const status = collected.status === 'not_tracked' ? 'failed' : collected.status;
      return this.d.repo.update(p.id, { status, reason: collected.reason, postIds: collected.posts.map((x) => x.id) });
    }
    // Spec 041 FR-008: a style is learnt from text — too few posts with text is a refusal before any LLM run.
    const texted = collected.posts.filter(hasPostText).length;
    if (texted < MIN_TEXT_POSTS) {
      return this.d.repo.update(p.id, {
        status: 'too_few_posts', postIds: collected.posts.map((x) => x.id),
        reason: `insufficient_data: ${texted} of ${collected.posts.length} posts have text — at least ${MIN_TEXT_POSTS} are needed to learn the style`,
      });
    }
    const state = await this.d.state(p.channelKey);
    const metrics = computeMetrics(collected.posts, state.card?.timezone ?? 'Europe/Kyiv');
    await this.d.repo.update(p.id, {
      status: 'analyzing', postIds: collected.posts.map((x) => x.id), metrics, agentId: state.agent?.id ?? null,
      baseline: sectionBaseline(state, p.resourceRef), retryAt: null, reason: null,
    });
    let res: AgentLoopResult;
    try {
      res = await this.runOnboarder(p, collected, state, metrics);
    } catch (err: any) {
      return this.d.repo.update(p.id, { status: 'failed', reason: `analysis: ${String(err?.message ?? err).slice(0, 300)}` });
    }
    const setup = res.terminalTool === SUBMIT_SETUP_TOOL ? (res.terminalResult as { setup?: unknown } | undefined)?.setup : undefined;
    const parsed = setup ? SubmitSetupInput.safeParse(setup) : null;
    if (!parsed?.success) {
      return this.d.repo.update(p.id, {
        status: 'failed', runId: res.runId, costUsd: res.totals.costUsd,
        reason: `The analysis ended without a valid proposal (${res.status}${res.error ? `: ${res.error}` : ''})`.slice(0, 400),
      });
    }
    const pending = Object.fromEntries(SETUP_SECTIONS.map((s) => [s, 'pending'])) as Record<SetupSection, SectionState>;
    // Spec 041 FR-008: under 7 days of history the posting rate and quiet hours are not proposed (best hours stay).
    const short = metrics.spanDays < MIN_SPAN_DAYS;
    const sections = short ? { ...parsed.data, schedule: { ...parsed.data.schedule, insufficient_span: true } } : parsed.data;
    return this.d.repo.update(p.id, {
      status: 'ready', runId: res.runId, costUsd: res.totals.costUsd, sections, sectionStatus: pending,
      ...(short ? { reason: `insufficient_span: the posts span ${metrics.spanDays} days (under ${MIN_SPAN_DAYS}) — the posting rate and quiet hours are not proposed` } : {}),
    });
  }

  private async runOnboarder(p: SetupProposal, c: Extract<CollectResult, { status: 'ok' }>, state: ChannelState, metrics: ChannelMetrics): Promise<AgentLoopResult> {
    const locks = state.locks;
    const lockedSeries = (state.playbook?.series ?? []).filter((s) => s.resource_ref === p.resourceRef && s.locked).map((s) => s.name);
    const tool = buildSubmitSetupTool({
      posts: c.posts, metrics, datasets: state.datasets,
      // The would-be playbook must pass the playbook checks (series per day, formats, cadence).
      extra: (i) => {
        const card = state.card ?? { formats: i.format_mix.formats as Record<string, number>, postsPerDayMin: i.schedule.posts_per_day_min, postsPerDayMax: i.schedule.posts_per_day_max };
        const body = mergePlaybook(state.playbook, p.resourceRef, card, {
          formatMix: i.format_mix.formats as Record<string, number>,
          schedule: { min: i.schedule.posts_per_day_min, max: i.schedule.posts_per_day_max, bestHours: i.schedule.best_hours },
          series: i.series_pillars,
        });
        const resources = body.platforms.map((x) => ({ ref: x.resource_ref, platform: x.resource_ref.slice(0, x.resource_ref.indexOf(':')) as 'telegram' }));
        return validatePlaybook(body, resources, Object.keys(i.format_mix.formats)).map((e) => `плейбук: ${e}`);
      },
    });
    const model = await this.d.model(state.agent, state.card);
    return this.d.loop.run({
      role: 'onboarder', channelKey: p.channelKey, model,
      system: onboarderSystemPrompt(),
      user: onboarderUserPrompt({
        channelKey: p.channelKey, title: state.card?.title ?? c.channel.title, about: c.channel.about, subscribers: c.channel.subsCount,
        posts: c.posts, metrics, lockedFormat: locks, lockedSeries,
        current: { brief: state.card?.brief?.trim() || null, profile: state.profile ? renderProfile(state.profile) : null },
        datasets: state.datasets,
      }),
      tools: [tool], maxSteps: ONBOARDER_MAX_STEPS,
      channelBudgetUsd: state.card?.dailyBudgetUsd ?? null,
      agent: state.agent ? { id: state.agent.id, handle: state.agent.handle, limitUsd: state.agent.dailyBudgetUsd } : null,
      usage: { feature: editorFeature('onboarder'), shadow: false },
      maxCostUsd: ONBOARDER_MAX_COST_USD,
    });
  }

  // ── reading ───────────────────────────────────────────────────────────────

  async overview(): Promise<{ channels: OverviewRow[]; estimateUsd: number | null }> {
    const { rows } = await this.d.pool.query(
      `SELECT tc.channel_key, COALESCE(ec.title, tc.title) AS title, tc.tracking_status,
              (SELECT count(*)::int FROM tracked_posts tp WHERE tp.channel_id = tc.id) AS posts,
              ec.channel_key IS NOT NULL AS has_card, ec.mode, COALESCE(btrim(ec.brief), '') <> '' AS has_brief,
              (rp.profile IS NOT NULL AND rp.profile <> '{}'::jsonb) AS has_profile,
              a.handle AS agent_handle,
              EXISTS (SELECT 1 FROM playbooks pb WHERE pb.agent_id = a.id AND pb.status = 'active') AS has_playbook
         FROM tracked_channels tc
         LEFT JOIN editor_channels ec ON ec.channel_key = tc.channel_key
         LEFT JOIN resource_profiles rp ON rp.resource_ref = 'telegram:' || tc.channel_key
         LEFT JOIN agents a ON a.kind = 'orchestrator' AND a.scope = 'resource' AND a.parent_id IS NULL
                           AND a.scope_id = 'telegram:' || tc.channel_key
        WHERE tc.is_mine AND tc.channel_key IS NOT NULL
        ORDER BY tc.channel_key`);
    const latest = await this.d.repo.latestByChannel();
    const est = await this.d.pool.query(
      `SELECT avg(cost_usd)::float AS avg FROM (
         SELECT cost_usd FROM editor_runs WHERE role = 'onboarder' AND status = 'ok' ORDER BY started_at DESC LIMIT 20) r`);
    const avg = est.rows[0]?.avg;
    return {
      channels: rows.map((r: any): OverviewRow => {
        const l = latest.get(r.channel_key);
        return {
          channelKey: r.channel_key, title: r.title ?? null, trackingStatus: r.tracking_status ?? 'unknown', postsStored: Number(r.posts ?? 0),
          hasCard: !!r.has_card, mode: r.mode ?? null, hasBrief: !!r.has_brief, hasProfile: !!r.has_profile, hasPlaybook: !!r.has_playbook,
          agentHandle: r.agent_handle ?? null,
          latest: l ? { id: l.id, status: l.status, reason: l.reason, createdAt: l.createdAt, costUsd: l.costUsd } : null,
        };
      }),
      estimateUsd: avg == null ? null : Math.round(Number(avg) * 10_000) / 10_000,
    };
  }

  async list(channel?: string | null) {
    return { proposals: (await this.d.repo.list(channel || null)).map(brief) };
  }

  /** A proposal with its posts (for the evidence), what changed since the analysis and the locked fields it keeps. */
  async get(id: string) {
    const p = await this.require(id);
    const posts = await this.postsOf(p);
    let drift: SetupSection[] = [];
    let kept: string[] = [];
    let current: Record<SetupSection, unknown> | null = null;
    if (p.sections && (p.status === 'ready' || p.status === 'partially_applied')) {
      const state = await this.d.state(p.channelKey);
      current = sectionBaseline(state, p.resourceRef);
      drift = driftedSections(p.baseline, current, pendingSections(p));
      const parsed = SubmitSetupInput.safeParse(p.sections);
      if (parsed.success) kept = formatPatch(parsed.data, state.locks, null).kept;
    }
    return {
      proposal: p,
      posts: posts.map((x) => ({
        key: x.key, id: x.id, msgId: x.msgId, postedAt: x.postedAt, firstLine: x.text.split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 160) ?? '',
        views: x.views, hasMedia: x.hasMedia, mediaType: x.mediaType,
        link: `https://t.me/${p.channelKey.replace(/^@/, '')}/${x.msgId}`,
      })),
      // What each section holds now (the dialog's "now → proposed"); null once the proposal is closed.
      current, drift, kept,
    };
  }

  // ── owner decisions ───────────────────────────────────────────────────────

  async apply(id: string, body: unknown) {
    const b = ApplyBody.safeParse(body ?? {});
    if (!b.success) throw new BadRequestException({ error: 'invalid_body', issues: b.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const p = await this.require(id);
    if (p.status !== 'ready' && p.status !== 'partially_applied') throw new ConflictException({ error: 'not_open', details: `the proposal is ${p.status}` });
    const parsed = SubmitSetupInput.safeParse(p.sections);
    if (!parsed.success) throw new ConflictException({ error: 'invalid_proposal', details: 'the stored sections no longer parse — run the analysis again' });
    const pending = pendingSections(p);
    const wanted = b.data.sections.filter((s) => pending.includes(s));
    if (!wanted.length) throw new BadRequestException({ error: 'nothing_to_apply', details: 'these sections are already applied' });

    const state = await this.d.state(p.channelKey);
    const override = new Set(b.data.override ?? []);
    const drift = driftedSections(p.baseline, sectionBaseline(state, p.resourceRef), wanted).filter((s) => !override.has(s));
    const go = wanted.filter((s) => !drift.includes(s));
    const posts = await this.postsOf(p);
    const out = go.length
      ? await applySections(this.d.writers, { channelKey: p.channelKey, ref: p.resourceRef, title: state.card?.title ?? null, input: parsed.data, posts, sections: go, state })
      : { applied: [] as SetupSection[], failed: null, kept: [] as string[], agent: state.agent, rebuilt: false };

    const sectionStatus = { ...p.sectionStatus };
    for (const s of out.applied) sectionStatus[s] = 'applied';
    const left = SETUP_SECTIONS.filter((s) => sectionStatus[s] !== 'applied' && sectionStatus[s] !== 'skipped');
    const updated = await this.d.repo.update(p.id, {
      sectionStatus, agentId: out.agent?.id ?? p.agentId,
      status: !out.applied.length && p.status === 'ready' ? 'ready' : left.length ? 'partially_applied' : 'applied',
      appliedAt: out.applied.length ? this.now() : p.appliedAt,
    });
    return {
      proposal: updated, applied: out.applied, kept: out.kept, rebuilt: out.rebuilt,
      failed: out.failed, changedSinceAnalysis: drift,
    };
  }

  async discard(id: string) {
    const p = await this.require(id);
    if (!['ready', 'partially_applied', 'queued', 'failed', 'no_access', 'too_few_posts'].includes(p.status)) {
      throw new ConflictException({ error: 'not_open', details: `the proposal is ${p.status}` });
    }
    // The sections not applied yet are skipped; the applied ones stay in its history.
    const sectionStatus = { ...p.sectionStatus };
    for (const s of SETUP_SECTIONS) if ((sectionStatus[s] ?? 'pending') === 'pending' && p.sections) sectionStatus[s] = 'skipped';
    return { proposal: await this.d.repo.update(p.id, { status: 'discarded', sectionStatus }) };
  }

  private async require(id: string): Promise<SetupProposal> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException({ error: 'proposal_not_found' });
    const p = await this.d.repo.get(id);
    if (!p) throw new NotFoundException({ error: 'proposal_not_found' });
    return p;
  }

  /** The proposal's posts in analysis order (p1 = the first stored id). */
  private async postsOf(p: SetupProposal): Promise<SetupPost[]> {
    if (!p.postIds.length) return [];
    const { rows } = await this.d.pool.query(
      `SELECT id, tg_message_id, text, has_media, media_type, posted_at, views, forwards, reactions_total, comments_count
         FROM tracked_posts WHERE id = ANY($1::uuid[])`, [p.postIds]);
    const byId = new Map(rows.map((r: any) => [r.id, r]));
    return p.postIds.map((id, i) => {
      const r: any = byId.get(id);
      if (!r) return null;
      return {
        key: `p${i + 1}`, id, msgId: Number(r.tg_message_id), postedAt: new Date(r.posted_at), text: r.text ?? '',
        hasMedia: !!r.has_media, mediaType: r.media_type ?? null,
        views: r.views == null ? null : Number(r.views), forwards: r.forwards == null ? null : Number(r.forwards),
        reactionsTotal: r.reactions_total == null ? null : Number(r.reactions_total), comments: r.comments_count == null ? null : Number(r.comments_count),
      };
    }).filter((x): x is SetupPost => !!x);
  }
}

function pendingSections(p: SetupProposal): SetupSection[] {
  return SETUP_SECTIONS.filter((s) => (p.sectionStatus[s] ?? 'pending') === 'pending');
}

/** A proposal without the heavy fields, for lists. */
function brief(p: SetupProposal) {
  const { sections: _s, baseline: _b, metrics: _m, ...rest } = p;
  return rest;
}
