import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { EditorCard } from '../card';
import type { Agent } from '../agents/agent.types';
import type { AgentLoop, AgentLoopResult } from '../harness/agent-loop';
import type { ModelProfile } from '../llm/model-registry';
import { editorFeature } from '../../common/ai/usage/features';
import { validatePlaybook } from '../network/playbook';
import { mergePlaybook, type ChannelState } from '../setup/setup-apply';
import type { ChannelMetrics } from '../setup/setup-metrics';
import { parseSourceRef } from '../steering/steering-source';
import { targetOf, type CreateResult } from '../steering/steering.service';
import { refName } from '../steering/steering.repository';
import type { SteeringSet } from '../steering/steering.types';
import {
  buildSubmitLaunchTool, launchSystemPrompt, launchUserPrompt, SUBMIT_LAUNCH_TOOL, SubmitLaunchInput, type LaunchReference,
} from './launch-analysis';
import type { LaunchRepository } from './launch.repository';
import {
  MAX_BRIEF_CHARS, MAX_REFERENCES, MIN_BRIEF_CHARS, PRE_START_STATUSES, type ChannelLaunch, type LaunchBotState, type LaunchRef,
} from './launch.types';

/**
 * Spec 052 FR-001: the launch of a new channel. `create` checks and stores the launch; one in-process worker (kicked on
 * create and by the editor's minute tick) advances it: `queued` (card + agent in `off`, the references queued as
 * steering sets) → `preparing` (waits for the sets) → `analyzing` (one onboarder run) → `ready` with the plan, or
 * `failed` with the reason. The owner redoes or discards it before Start.
 */

export const LAUNCH_MAX_STEPS = 4;
export const LAUNCH_MAX_COST_USD = 0.4;
/** A launch left `analyzing` this long (a restart mid-run) goes back to `preparing`. */
const STUCK_MS = 15 * 60_000;
/** References not read this long after the launch was queued are skipped (the plan comes from the brief). */
export const REFERENCE_WAIT_MS = 60 * 60_000;
/** Steering statuses that are still working. */
const SET_WORKING = ['queued', 'collecting', 'analyzing'];
/** Steering statuses whose rules the launch uses. */
const SET_USABLE = ['ready', 'active', 'paused'];

export type LaunchRefusal =
  | 'invalid_body' | 'invalid_target' | 'brief_too_short' | 'brief_too_long' | 'too_many_references' | 'invalid_reference'
  | 'same_channel' | 'already_running' | 'already_open';

export type CreateLaunchResult =
  | { ok: true; launch: ChannelLaunch }
  | { ok: false; error: LaunchRefusal; details: string; launch?: ChannelLaunch };

export interface LaunchSteering {
  createSet(body: { target: string; source: string }, createdBy: string): Promise<CreateResult>;
  set(id: string): Promise<SteeringSet | null>;
  discard(id: string): Promise<unknown>;
}

export interface LaunchDeps {
  repo:     LaunchRepository;
  card:     (channelKey: string) => Promise<EditorCard | null>;
  /** The card in mode `off` (created when missing, with the title) and the channel's orchestrator. */
  prepareChannel: (channelKey: string, title: string | null) => Promise<Agent>;
  /** Bot API: is the channel's bot (or the default bot) an admin that may post; the chat's title and description. */
  botCheck: (channelKey: string) => Promise<LaunchBotState>;
  steering: LaunchSteering;
  /** The network's other own channels (title, topic) — the new one should not duplicate them. */
  network:  (channelKey: string) => Promise<Array<{ key: string; title: string | null; topic: string | null }>>;
  /** The channel's card, agent, profile, locks, playbook and voice skill now (042). */
  state:    (channelKey: string) => Promise<ChannelState>;
  loop:     Pick<AgentLoop, 'run'>;
  model:    (agent: Agent | null, card: EditorCard | null) => Promise<ModelProfile>;
  now?:     () => Date;
  log?:     (msg: string) => void;
}

const CreateBody = z.object({
  target:     z.string().trim().min(2).max(200),
  references: z.array(z.string().trim().min(2).max(300)).max(20).default([]),
  brief:      z.string().trim().max(20_000),
}).strict();

const RedoBody = z.object({
  brief:      z.string().trim().min(MIN_BRIEF_CHARS).max(MAX_BRIEF_CHARS).optional(),
}).strict();

const errText = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 300);

export class LaunchService {
  private worker: Promise<void> | null = null;

  constructor(private readonly d: LaunchDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  // ── create ────────────────────────────────────────────────────────────────

  /** Validate and store; refusals are data (the chat and the @ai0 tool show them, the API throws). */
  async createLaunch(body: unknown, createdBy = 'owner'): Promise<CreateLaunchResult> {
    const b = CreateBody.safeParse(body ?? {});
    if (!b.success) return { ok: false, error: 'invalid_body', details: b.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    const target = targetOf(b.data.target.replace(/^(https?:\/\/)?(www\.)?t\.me\//i, '@'));
    if (!target) return { ok: false, error: 'invalid_target', details: `${b.data.target} is not a channel handle (@name or a t.me link)` };
    const brief = b.data.brief;
    if (brief.length < MIN_BRIEF_CHARS) return { ok: false, error: 'brief_too_short', details: `Describe the channel in at least ${MIN_BRIEF_CHARS} characters: what it publishes and for whom` };
    if (brief.length > MAX_BRIEF_CHARS) return { ok: false, error: 'brief_too_long', details: `The brief is limited to ${MAX_BRIEF_CHARS} characters` };
    const refs: string[] = [];
    for (const raw of b.data.references) {
      const p = parseSourceRef(raw);
      if ('error' in p) return { ok: false, error: 'invalid_reference', details: `${raw}: ${p.details}` };
      if (p.ref.toLowerCase() === target.ref.toLowerCase()) return { ok: false, error: 'same_channel', details: 'A reference must be another channel' };
      if (!refs.some((r) => r.toLowerCase() === p.ref.toLowerCase())) refs.push(p.ref);
    }
    if (refs.length > MAX_REFERENCES) return { ok: false, error: 'too_many_references', details: `At most ${MAX_REFERENCES} references` };

    const open = await this.d.repo.openFor(target.key);
    if (open) return { ok: false, error: 'already_open', details: `${target.key} already has a launch (${open.status})`, launch: open };
    const card = await this.d.card(target.key);
    if (card && (card.mode === 'approve' || card.mode === 'live')) {
      return { ok: false, error: 'already_running', details: `${target.key} already runs in ${card.mode} mode — use /setup or the agent page` };
    }
    const launch = await this.d.repo.insert({
      channelKey: target.key, title: card?.title ?? null, brief, createdBy,
      refs: refs.map((ref): LaunchRef => ({ ref, setId: null, status: 'queued', reason: null, title: null })),
    });
    if (!launch) {
      const again = await this.d.repo.openFor(target.key);
      return { ok: false, error: 'already_open', details: `${target.key} already has a launch`, ...(again ? { launch: again } : {}) };
    }
    this.kick();
    return { ok: true, launch };
  }

  async create(body: unknown, createdBy = 'owner') {
    const r = await this.createLaunch(body, createdBy);
    if (r.ok) return { launch: r.launch };
    if (r.error === 'already_open' || r.error === 'already_running') throw new ConflictException({ error: r.error, details: r.details, launch: r.launch });
    throw new BadRequestException({ error: r.error, details: r.details });
  }

  // ── worker ────────────────────────────────────────────────────────────────

  /** Start the worker when idle (never awaited by callers). */
  kick(): void {
    if (this.worker) return;
    this.worker = this.drain()
      .catch((err) => this.d.log?.(`launch worker failed: ${err?.message ?? err}`))
      .finally(() => { this.worker = null; });
  }

  /** Resolves when the worker started by `kick` has drained (tests). */
  async idle(): Promise<void> {
    while (this.worker) await this.worker;
  }

  /** The editor's minute tick: stuck launches back to `preparing`, then the worker. */
  async tick(): Promise<void> {
    await this.d.repo.requeueStuck(new Date(this.now().getTime() - STUCK_MS)).catch(() => 0);
    this.kick();
  }

  private async drain(): Promise<void> {
    // Each pass handles every launch once; a launch waiting for its references stays `preparing` until a later tick.
    const due = await this.d.repo.active(['queued', 'preparing'], this.now());
    for (const l of due) {
      try {
        await this.advance(l);
      } catch (err) {
        this.d.log?.(`launch ${l.channelKey}: ${errText(err)}`);
      }
    }
  }

  /** One step of a launch before Start. Exported for tests. */
  async advance(l: ChannelLaunch): Promise<ChannelLaunch | null> {
    if (l.status === 'queued') {
      const next = await this.begin(l);
      // Without references (or with all of them refused) the analysis runs at once.
      return next?.status === 'preparing' ? this.prepare(next) : next;
    }
    if (l.status === 'preparing') return this.prepare(l);
    return l;
  }

  /** `queued`: the bot check (title, description), the card and agent in `off`, the references queued as steering sets. */
  private async begin(l: ChannelLaunch): Promise<ChannelLaunch | null> {
    const bot = await this.d.botCheck(l.channelKey).catch((err): LaunchBotState => ({ state: 'unknown', detail: errText(err), bot: null }));
    const title = l.title ?? bot.chatTitle ?? null;
    let agent: Agent;
    try {
      agent = await this.d.prepareChannel(l.channelKey, title);
    } catch (err) {
      return this.d.repo.transition(l.id, ['queued'], { status: 'failed', reason: `card: ${errText(err)}`, botState: bot, botCheckedAt: this.now() });
    }
    const refs: LaunchRef[] = [];
    for (const r of l.refs) {
      if (r.setId) { refs.push(r); continue; }
      const res = await this.d.steering.createSet({ target: l.channelKey, source: r.ref }, 'launch');
      if (res.ok) refs.push({ ...r, setId: res.set.id, status: res.set.status, reason: null });
      else if (res.error === 'already_open' && res.set) refs.push({ ...r, setId: res.set.id, status: res.set.status, reason: null });
      else refs.push({ ...r, status: 'skipped', reason: res.details });
    }
    return this.d.repo.transition(l.id, ['queued'], {
      status: 'preparing', refs, title, agentId: agent.id, botState: bot, botCheckedAt: this.now(), reason: null, retryAt: null,
    });
  }

  /** `preparing`: wait for the reference sets (at most REFERENCE_WAIT_MS), then the analysis. */
  private async prepare(l: ChannelLaunch): Promise<ChannelLaunch | null> {
    const refs: LaunchRef[] = [];
    const sets = new Map<string, SteeringSet>();
    let waiting = false;
    const late = this.now().getTime() - l.createdAt.getTime() > REFERENCE_WAIT_MS;
    for (const r of l.refs) {
      if (!r.setId) { refs.push(r); continue; }
      const s = await this.d.steering.set(r.setId).catch(() => null);
      if (!s) { refs.push({ ...r, status: 'skipped', reason: r.reason ?? 'the steering set is gone' }); continue; }
      const title = s.sourceTitle ?? r.title;
      if (SET_WORKING.includes(s.status)) {
        if (late) refs.push({ ...r, title, status: 'skipped', reason: 'not read within an hour — the plan comes from the brief' });
        else { waiting = true; refs.push({ ...r, title, status: s.status }); }
      } else if (SET_USABLE.includes(s.status)) {
        sets.set(r.ref, s);
        refs.push({ ...r, title, status: s.status, reason: null });
      } else {
        refs.push({ ...r, title, status: 'skipped', reason: s.reason ?? s.status });
      }
    }
    if (waiting) return this.d.repo.update(l.id, { refs });
    const claimed = await this.d.repo.transition(l.id, ['preparing'], { status: 'analyzing', refs });
    if (!claimed) return null;
    return this.analyze(claimed, sets);
  }

  private async analyze(l: ChannelLaunch, sets: Map<string, SteeringSet>): Promise<ChannelLaunch | null> {
    const state = await this.d.state(l.channelKey);
    const references: LaunchReference[] = [...sets.entries()].map(([ref, s]) => ({
      ref, title: s.sourceTitle, summary: s.summary, rules: s.rules, metrics: (s.metrics as ChannelMetrics | null) ?? null,
      texts: s.posts.map((p) => p.text).filter(Boolean),
    }));
    const skipped = l.refs.filter((r) => r.status === 'skipped').map((r) => ({ ref: r.ref, reason: r.reason ?? 'skipped' }));
    let res: AgentLoopResult;
    try {
      res = await this.runAnalysis(l, state, references, skipped);
    } catch (err) {
      return this.d.repo.transition(l.id, ['analyzing'], { status: 'failed', reason: `analysis: ${errText(err)}` });
    }
    const out = res.terminalTool === SUBMIT_LAUNCH_TOOL ? (res.terminalResult as { launch?: unknown } | undefined)?.launch : undefined;
    const parsed = out ? SubmitLaunchInput.safeParse(out) : null;
    const cost = l.costUsd + (res.totals.costUsd ?? 0);
    if (!parsed?.success) {
      return this.d.repo.transition(l.id, ['analyzing'], {
        status: 'failed', runId: res.runId, costUsd: cost,
        reason: `The analysis ended without a valid plan (${res.status}${res.error ? `: ${res.error}` : ''})`.slice(0, 400),
      });
    }
    return this.d.repo.transition(l.id, ['analyzing'], { status: 'ready', plan: parsed.data, runId: res.runId, costUsd: cost, reason: null });
  }

  private async runAnalysis(l: ChannelLaunch, state: ChannelState, references: LaunchReference[], skipped: Array<{ ref: string; reason: string }>): Promise<AgentLoopResult> {
    const tool = buildSubmitLaunchTool({
      brief: l.brief, references,
      // The would-be playbook must pass the playbook checks (series per day, formats, cadence).
      extra: (i) => {
        const card = { formats: i.format_mix.formats as Record<string, number>, postsPerDayMin: i.schedule.posts_per_day_min, postsPerDayMax: i.schedule.posts_per_day_max };
        const body = mergePlaybook(state.playbook, l.targetRef, card, {
          formatMix: i.format_mix.formats as Record<string, number>,
          schedule: { min: i.schedule.posts_per_day_min, max: i.schedule.posts_per_day_max, bestHours: i.schedule.best_hours },
          series: { ...i.series_pillars, series: i.series_pillars.series.map((s) => ({ ...s, post_ids: [] })), evidence: { post_ids: [], note: 'launch' } },
        });
        const resources = body.platforms.map((x) => ({ ref: x.resource_ref, platform: x.resource_ref.slice(0, x.resource_ref.indexOf(':')) as 'telegram' }));
        return validatePlaybook(body, resources, Object.keys(i.format_mix.formats)).map((e) => `плейбук: ${e}`);
      },
    });
    const network = await this.d.network(l.channelKey).catch((): Array<{ key: string; title: string | null; topic: string | null }> => []);
    const model = await this.d.model(state.agent, state.card);
    return this.d.loop.run({
      role: 'onboarder', channelKey: l.channelKey, model,
      system: launchSystemPrompt(),
      user: launchUserPrompt({
        channelKey: l.channelKey, title: l.title, about: l.botState?.chatAbout ?? null, brief: l.brief, references, skipped,
        network: network.filter((n) => n.key.toLowerCase() !== l.channelKey.toLowerCase()),
      }),
      tools: [tool], maxSteps: LAUNCH_MAX_STEPS,
      channelBudgetUsd: state.card?.dailyBudgetUsd ?? null,
      agent: state.agent ? { id: state.agent.id, handle: state.agent.handle, limitUsd: state.agent.dailyBudgetUsd } : null,
      usage: { feature: editorFeature('launch'), shadow: false },
      maxCostUsd: LAUNCH_MAX_COST_USD,
    });
  }

  // ── reading ───────────────────────────────────────────────────────────────

  async get(id: string): Promise<ChannelLaunch> {
    const l = await this.d.repo.get(id);
    if (!l) throw new NotFoundException({ error: 'launch_not_found' });
    return l;
  }

  async list(channel?: string | null) {
    return { launches: (await this.d.repo.list({ channel: channel || null })).map(launchJson) };
  }

  /** The launch for the API and the artifact panel. */
  async view(l: ChannelLaunch) {
    return launchJson(l);
  }

  async viewById(id: string) {
    return { launch: await this.view(await this.get(id)) };
  }

  // ── owner decisions before Start ──────────────────────────────────────────

  /** Run the analysis again (a new brief optional); the references already read are kept. */
  async redo(id: string, body: unknown = {}) {
    const b = RedoBody.safeParse(body ?? {});
    if (!b.success) throw new BadRequestException({ error: 'invalid_body', details: b.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    const l = await this.get(id);
    if (l.status !== 'ready' && l.status !== 'failed') throw new ConflictException({ error: 'not_redoable', details: `the launch is ${l.status}` });
    if (l.status === 'failed' && (await this.d.repo.openFor(l.channelKey))) {
      throw new ConflictException({ error: 'already_open', details: `${l.channelKey} has another open launch` });
    }
    // A reference that was skipped is read again.
    const refs = l.refs.map((r) => (r.status === 'skipped' ? { ...r, setId: null, status: 'queued', reason: null } : r));
    const next = await this.d.repo.transition(id, ['ready', 'failed'], {
      status: 'queued', plan: null, reason: null, retryAt: null, refs, ...(b.data.brief ? { brief: b.data.brief } : {}),
    });
    if (!next) throw new ConflictException({ error: 'not_redoable', details: 'the launch changed meanwhile' });
    this.kick();
    return { launch: next };
  }

  /**
   * Stop the launch. Before Start its reference sets that never became active are discarded too; the card stays `off`
   * (the owner removes the agent from its page if they want). A running launch stops watching graduation and promos.
   */
  async discard(id: string) {
    const l = await this.get(id);
    const open = [...PRE_START_STATUSES, 'running'] as string[];
    if (!open.includes(l.status)) throw new ConflictException({ error: 'not_open', details: `the launch is ${l.status}` });
    const next = await this.d.repo.transition(id, [l.status], { status: 'discarded', startRequested: false });
    if (!next) throw new ConflictException({ error: 'not_open', details: 'the launch changed meanwhile' });
    if (l.status !== 'running') {
      for (const r of l.refs) {
        if (!r.setId) continue;
        const s = await this.d.steering.set(r.setId).catch(() => null);
        if (s && ['queued', 'ready', 'failed', 'no_access', 'too_few_posts'].includes(s.status)) await this.d.steering.discard(r.setId).catch(() => {});
      }
    }
    return { launch: next };
  }

}

/** The stored launch as JSON (dates as ISO strings; the references with their names). */
export function launchJson(l: ChannelLaunch) {
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return {
    id: l.id, channelKey: l.channelKey, targetRef: l.targetRef, title: l.title, brief: l.brief,
    refs: l.refs.map((r) => ({ ...r, name: refName(r.ref) })), status: l.status, reason: l.reason, plan: l.plan,
    startRequested: l.startRequested, startedAt: iso(l.startedAt), graduation: l.graduation, promo: l.promo, subsAtStart: l.subsAtStart,
    bot: l.botState ? { ...l.botState, checkedAt: iso(l.botCheckedAt) } : null, costUsd: l.costUsd, createdBy: l.createdBy,
    createdAt: iso(l.createdAt), updatedAt: iso(l.updatedAt), graduatedAt: iso(l.graduatedAt),
  };
}
