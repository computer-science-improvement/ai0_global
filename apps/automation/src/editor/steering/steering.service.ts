import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { EditorCard } from '../card';
import type { Agent } from '../agents/agent.types';
import type { AgentLoop, AgentLoopResult } from '../harness/agent-loop';
import type { ModelProfile } from '../llm/model-registry';
import { editorFeature } from '../../common/ai/usage/features';
import { isFloodWait } from '../../common/telegram/flood-wait';
import { computeMetrics } from '../setup/setup-metrics';
import {
  buildSubmitSteeringTool, ruleTextProblemsEn, steeringSystemPrompt, steeringUserPrompt, SUBMIT_STEERING_TOOL, SubmitSteeringInput,
  toRules, type SteeringTarget,
} from './steering-analysis';
import { asSetupPosts, parseSourceRef, type ReadResult, type SteeringSourceReader } from './steering-source';
import { refName, withoutTexts, type SteeringRepository } from './steering.repository';
import { MAX_ACTIVE_SETS, MAX_RULES, RULE_TEXT_MAX, STEERING_RULE_KINDS, type SteeringRule, type SteeringSet, type SteeringStatus } from './steering.types';
import { errText } from '../../common/err-text';

/**
 * Spec 045: steering. `create` queues a set (target = an own channel with a card, source = a public resource); one
 * in-process worker takes queued sets one at a time (kicked on create and by the editor's minute tick), reads the
 * reference, computes the metrics and runs the onboarder once; the owner reviews the rules and activates the set.
 * Active sets feed the target's prompts as the lowest-priority rule source (FR-005).
 */

export const STEERING_MAX_STEPS = 4;
export const STEERING_MAX_COST_USD = 0.3;
/** A set stuck in collecting / analyzing this long (a restart mid-run) goes back to the queue. */
const STUCK_MS = 15 * 60_000;
/** Sets the owner may discard (not while the worker holds them). */
const DISCARDABLE: readonly SteeringStatus[] = ['queued', 'ready', 'active', 'paused', 'failed', 'no_access', 'too_few_posts'];
const CLOSED: readonly SteeringStatus[] = ['discarded', 'superseded', 'failed', 'no_access', 'too_few_posts'];

export interface SteeringTargetState {
  card:   EditorCard | null;
  agent:  Agent | null;
  target: SteeringTarget;
}

export interface SteeringDeps {
  repo:     SteeringRepository;
  /** Readers by platform (`telegram` now). */
  readers:  Record<string, SteeringSourceReader>;
  /** Whether a channel key is one of our tracked channels. */
  isOwn:    (channelKey: string) => Promise<boolean>;
  /** The target's card, agent and rules now; null card = no editor card. */
  target:   (targetRef: string) => Promise<SteeringTargetState>;
  loop:     Pick<AgentLoop, 'run'>;
  model:    (agent: Agent | null, card: EditorCard | null) => Promise<ModelProfile>;
  now?:     () => Date;
  log?:     (msg: string) => void;
}

export type CreateRefusal = 'invalid_body' | 'invalid_source' | 'not_own_channel' | 'no_card' | 'same_channel' | 'already_open';
export type CreateResult =
  | { ok: true; set: SteeringSet }
  | { ok: false; error: CreateRefusal; details: string; set?: SteeringSet };

const CreateBody = z.object({
  target: z.string().trim().min(2).max(200),
  source: z.string().trim().min(2).max(300),
}).strict();

const RulePatch = z.object({
  enabled: z.boolean().optional(),
  text:    z.string().trim().min(10).max(RULE_TEXT_MAX).optional(),
}).strict().refine((b) => b.enabled !== undefined || b.text !== undefined, { message: 'enabled or text' });

/** `@mine`, `mine`, `telegram:@mine` → { ref: telegram:@mine, key: @mine }. */
export function targetOf(input: string): { ref: string; key: string } | null {
  const bare = input.trim().replace(/^telegram:/, '').replace(/^@/, '');
  if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(bare)) return null;
  return { ref: `telegram:@${bare}`, key: `@${bare}` };
}

/** Spec 048 FR-001 / FR-002: several rule changes at once (the artifact panel, an agent's update_artifact). */
export const RulesEdit = z.object({
  rules:  z.array(z.object({ id: z.string().min(1).max(20), enabled: z.boolean().optional(), text: z.string().trim().min(10).max(RULE_TEXT_MAX).optional() }).strict()).max(MAX_RULES).optional(),
  add:    z.array(z.object({ kind: z.enum(STEERING_RULE_KINDS), text: z.string().trim().min(10).max(RULE_TEXT_MAX) }).strict()).max(MAX_RULES).optional(),
  remove: z.array(z.string().min(1).max(20)).max(MAX_RULES).optional(),
}).strict().refine((b) => !!(b.rules?.length || b.add?.length || b.remove?.length), { message: 'rules, add or remove' });

const platformOf = (ref: string) => ref.slice(0, ref.indexOf(':'));

export class SteeringService {
  private worker: Promise<void> | null = null;

  constructor(private readonly d: SteeringDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  // ── create / queue ────────────────────────────────────────────────────────

  /** Validate and queue; refusals are data (the @ai0 tool returns them, the API throws). */
  async createSet(body: unknown, createdBy = 'owner'): Promise<CreateResult> {
    const b = CreateBody.safeParse(body ?? {});
    if (!b.success) return { ok: false, error: 'invalid_body', details: b.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    const source = parseSourceRef(b.data.source);
    if ('error' in source) return { ok: false, error: 'invalid_source', details: source.details };
    const target = targetOf(b.data.target);
    if (!target || !(await this.d.isOwn(target.key))) {
      return { ok: false, error: 'not_own_channel', details: `${b.data.target} is not one of your tracked channels` };
    }
    if (source.ref.toLowerCase() === target.ref.toLowerCase()) {
      return { ok: false, error: 'same_channel', details: 'The reference must be another channel' };
    }
    const state = await this.d.target(target.ref);
    if (!state.card) return { ok: false, error: 'no_card', details: `${target.key} has no editor card yet — set the channel up first` };
    if (!this.d.readers[platformOf(source.ref)]) return { ok: false, error: 'invalid_source', details: `${platformOf(source.ref)} references are not supported yet` };
    const { set, created } = await this.d.repo.enqueue({ targetRef: target.ref, channelKey: target.key, sourceRef: source.ref, createdBy });
    if (!created) return { ok: false, error: 'already_open', details: `${refName(source.ref)} is already being analysed for ${target.key}`, set };
    this.kick();
    return { ok: true, set };
  }

  async create(body: unknown, createdBy = 'owner') {
    const r = await this.createSet(body, createdBy);
    if (r.ok) return { set: r.set };
    if (r.error === 'already_open') throw new ConflictException({ error: r.error, details: r.details, set: r.set });
    if (r.error === 'no_card' || r.error === 'not_own_channel') throw new ConflictException({ error: r.error, details: r.details });
    throw new BadRequestException({ error: r.error, details: r.details });
  }

  /** Start the worker when idle (never awaited by callers). */
  kick(): void {
    if (this.worker) return;
    this.worker = this.drain()
      .catch((err) => this.d.log?.(`steering worker failed: ${errText(err)}`))
      .finally(() => { this.worker = null; });
  }

  /** Resolves when the worker started by `kick` has drained the queue (tests). */
  async idle(): Promise<void> {
    while (this.worker) await this.worker;
  }

  /** The editor's minute tick: stuck sets back to the queue, then the worker. */
  async tick(): Promise<void> {
    await this.d.repo.requeueStuck(new Date(this.now().getTime() - STUCK_MS)).catch(() => 0);
    this.kick();
  }

  private async drain(): Promise<void> {
    for (;;) {
      const next = await this.d.repo.claimNext(this.now());
      if (!next) return;
      await this.process(next);
    }
  }

  /** One set: read the reference → metrics → onboarder → rules (`ready`). */
  async process(s: SteeringSet): Promise<SteeringSet | null> {
    const busy = { from: ['collecting', 'analyzing'] as SteeringStatus[] };
    const reader = this.d.readers[platformOf(s.sourceRef)];
    if (!reader) return this.d.repo.update(s.id, { status: 'failed', reason: `No reader for ${platformOf(s.sourceRef)}` }, busy);
    let read: ReadResult;
    try {
      read = await reader.read(s.sourceRef);
    } catch (err) {
      const wait = isFloodWait(err);
      if (wait !== null) return this.d.repo.update(s.id, { status: 'queued', retryAt: new Date(this.now().getTime() + wait * 1000), reason: `Telegram asked to wait ${wait}s` }, busy);
      return this.d.repo.update(s.id, { status: 'failed', reason: `reading: ${String((err as Error)?.message ?? err).slice(0, 300)}` }, busy);
    }
    if (read.status !== 'ok') {
      return this.d.repo.update(s.id, {
        status: read.status, reason: read.reason, sourceTitle: read.info?.title ?? null, posts: withoutTexts(read.posts),
      }, busy);
    }
    const state = await this.d.target(s.targetRef);
    if (!state.card) return this.d.repo.update(s.id, { status: 'failed', reason: 'The target channel has no editor card' }, busy);
    const metrics = computeMetrics(asSetupPosts(read.posts), state.card.timezone ?? 'Europe/Kyiv');
    const analyzing = await this.d.repo.update(s.id, {
      status: 'analyzing', sourceTitle: read.info.title, posts: read.posts, metrics, retryAt: null, reason: null,
    }, busy);
    if (!analyzing) return null;
    let res: AgentLoopResult;
    try {
      const model = await this.d.model(state.agent, state.card);
      res = await this.d.loop.run({
        role: 'onboarder', channelKey: s.channelKey ?? state.card.channelKey, model,
        system: steeringSystemPrompt(),
        user: steeringUserPrompt({
          sourceRef: s.sourceRef, title: read.info.title, about: read.info.about, subscribers: read.info.subscribers,
          posts: read.posts, metrics, target: state.target,
        }),
        tools: [buildSubmitSteeringTool(read.posts)], maxSteps: STEERING_MAX_STEPS,
        channelBudgetUsd: state.card.dailyBudgetUsd ?? null,
        agent: state.agent ? { id: state.agent.id, handle: state.agent.handle, limitUsd: state.agent.dailyBudgetUsd } : null,
        usage: { feature: editorFeature('steering'), shadow: false },
        maxCostUsd: STEERING_MAX_COST_USD,
      });
    } catch (err: any) {
      return this.d.repo.update(s.id, { status: 'failed', reason: `analysis: ${errText(err).slice(0, 300)}` }, { from: ['analyzing'] });
    }
    const out = res.terminalTool === SUBMIT_STEERING_TOOL ? (res.terminalResult as { steering?: unknown } | undefined)?.steering : undefined;
    const parsed = out ? SubmitSteeringInput.safeParse(out) : null;
    if (!parsed?.success) {
      return this.d.repo.update(s.id, {
        status: 'failed', runId: res.runId, costUsd: res.totals.costUsd,
        reason: `The analysis ended without valid rules (${res.status}${res.error ? `: ${res.error}` : ''})`.slice(0, 400),
      }, { from: ['analyzing'] });
    }
    return this.d.repo.update(s.id, {
      status: 'ready', runId: res.runId, costUsd: res.totals.costUsd, summary: parsed.data.summary, rules: toRules(parsed.data),
    }, { from: ['analyzing'] });
  }

  // ── reading ───────────────────────────────────────────────────────────────

  async list(target?: string | null) {
    const t = target ? targetOf(target) : null;
    if (target && !t) return { sets: [] };
    return { sets: (await this.d.repo.list({ targetRef: t?.ref ?? null })).map(brief) };
  }

  async get(id: string) {
    const s = await this.require(id);
    const name = refName(s.sourceRef).replace(/^@/, '');
    return {
      set: { ...s, posts: undefined },
      posts: s.posts.map((p) => ({
        key: p.key, msgId: p.msgId, postedAt: p.postedAt, mediaType: p.mediaType, views: p.views, reactions: p.reactions,
        forwards: p.forwards, comments: p.comments,
        firstLine: p.text.split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 160) ?? '',
        link: platformOf(s.sourceRef) === 'telegram' ? `https://t.me/${name}/${p.msgId}` : null,
      })),
    };
  }

  async estimate() {
    return { estimateUsd: await this.d.repo.estimateUsd() };
  }

  /** Active sets per target for the agent page (`Steering: N active from @a, @b`). */
  async activeSummary(targetRef: string) {
    const sets = await this.d.repo.activeFor(targetRef);
    return { active: sets.length, sources: sets.map((s) => refName(s.sourceRef)) };
  }

  // ── owner decisions ───────────────────────────────────────────────────────

  async activate(id: string) {
    const r = await this.d.repo.activate(id, MAX_ACTIVE_SETS);
    if ('error' in r) return this.activationError(r.error, id);
    return { set: r.set };
  }

  async pause(id: string) {
    const s = await this.require(id);
    if (s.status !== 'active') throw new ConflictException({ error: 'not_active', details: `the set is ${s.status}` });
    return { set: await this.d.repo.update(id, { status: 'paused' }, { from: ['active'] }) };
  }

  async resume(id: string) {
    const s = await this.require(id);
    if (s.status !== 'paused') throw new ConflictException({ error: 'not_paused', details: `the set is ${s.status}` });
    const r = await this.d.repo.activate(id, MAX_ACTIVE_SETS);
    if ('error' in r) return this.activationError(r.error, id);
    return { set: r.set };
  }

  async discard(id: string) {
    const s = await this.require(id);
    if (!DISCARDABLE.includes(s.status)) throw new ConflictException({ error: 'not_open', details: `the set is ${s.status}` });
    return { set: await this.d.repo.update(id, { status: 'discarded', posts: withoutTexts(s.posts) }, { from: DISCARDABLE }) };
  }

  /** Read the reference again: a new set; the old one stays until the new one is activated. */
  async reanalyze(id: string, createdBy = 'owner') {
    const s = await this.require(id);
    if (!CLOSED.includes(s.status) && s.status !== 'active' && s.status !== 'paused') {
      throw new ConflictException({ error: 'already_open', details: `the set is ${s.status}` });
    }
    const { set, created } = await this.d.repo.enqueue({ targetRef: s.targetRef, channelKey: s.channelKey, sourceRef: s.sourceRef, createdBy });
    if (!created) throw new ConflictException({ error: 'already_open', details: 'an analysis of this reference is already open', set });
    this.kick();
    return { set };
  }

  async patchRule(id: string, ruleId: string, body: unknown) {
    const b = RulePatch.safeParse(body ?? {});
    if (!b.success) throw new BadRequestException({ error: 'invalid_body', issues: b.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const s = await this.require(id);
    if (!['ready', 'active', 'paused'].includes(s.status)) throw new ConflictException({ error: 'not_open', details: `the set is ${s.status}` });
    const rule = s.rules.find((r) => r.id === ruleId);
    if (!rule) throw new NotFoundException({ error: 'rule_not_found' });
    if (b.data.enabled && rule.conflict) {
      throw new ConflictException({ error: 'rule_conflict', details: `This rule contradicts ${rule.conflict.with}; the channel's own rules win, so it is never given to the agent` });
    }
    let text = rule.text;
    if (b.data.text !== undefined && b.data.text !== rule.text) {
      const problems = ruleTextProblemsEn(b.data.text, s.posts);
      if (problems.length) throw new BadRequestException({ error: 'rule_invalid', details: problems });
      text = b.data.text;
    }
    const rules = s.rules.map((r) => r.id !== ruleId ? r : {
      ...r, text, enabled: b.data.enabled ?? r.enabled, ...(text !== rule.text ? { edited: true } : {}),
    });
    return { set: await this.d.repo.update(id, { rules }, { from: ['ready', 'active', 'paused'] }) };
  }

  /** Spec 048: change, add and remove rules in one step; every new or changed text passes the rule lint and copy check. */
  async editRules(id: string, body: unknown) {
    const b = RulesEdit.safeParse(body ?? {});
    if (!b.success) throw new BadRequestException({ error: 'invalid_body', issues: b.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const s = await this.require(id);
    if (!['ready', 'active', 'paused'].includes(s.status)) throw new ConflictException({ error: 'not_open', details: `the set is ${s.status}` });
    const problems: string[] = [];
    const known = new Set(s.rules.map((r) => r.id));
    for (const ch of [...(b.data.rules ?? []).map((r) => r.id), ...(b.data.remove ?? [])]) {
      if (!known.has(ch)) throw new NotFoundException({ error: 'rule_not_found', details: ch });
    }
    const gone = new Set(b.data.remove ?? []);
    let rules: SteeringRule[] = s.rules.filter((r) => !gone.has(r.id)).map((r) => {
      const ch = b.data.rules?.find((c) => c.id === r.id);
      if (!ch) return r;
      if (ch.enabled && r.conflict) problems.push(`${r.id}: contradicts ${r.conflict.with}; the channel's own rules win`);
      const text = ch.text !== undefined && ch.text !== r.text ? ch.text : r.text;
      if (text !== r.text) problems.push(...ruleTextProblemsEn(text, s.posts).map((p) => `${r.id}: ${p}`));
      return { ...r, text, enabled: ch.enabled ?? r.enabled, ...(text !== r.text ? { edited: true } : {}) };
    });
    let n = s.rules.reduce((m, r) => Math.max(m, Number(r.id.replace(/\D/g, '')) || 0), 0);
    for (const a of b.data.add ?? []) {
      problems.push(...ruleTextProblemsEn(a.text, s.posts).map((p) => `new rule: ${p}`));
      rules = [...rules, { id: `s${++n}`, kind: a.kind, text: a.text, evidence: { post_ids: [], note: 'added by hand' }, conflict: null, enabled: true, edited: true }];
    }
    if (rules.length > MAX_RULES) problems.push(`a set keeps at most ${MAX_RULES} rules`);
    if (!rules.length) problems.push('a set keeps at least one rule — discard the set instead');
    if (problems.length) throw new BadRequestException({ error: 'rule_invalid', details: problems });
    return { set: await this.d.repo.update(id, { rules }, { from: ['ready', 'active', 'paused'] }) };
  }

  private async activationError(error: 'not_found' | 'not_ready' | 'too_many_active', id: string): Promise<never> {
    if (error === 'not_found') throw new NotFoundException({ error: 'set_not_found' });
    if (error === 'too_many_active') {
      throw new ConflictException({ error, details: `A channel follows at most ${MAX_ACTIVE_SETS} references — pause or discard one first` });
    }
    const s = await this.d.repo.get(id);
    throw new ConflictException({ error, details: `the set is ${s?.status ?? 'gone'}` });
  }

  private async require(id: string): Promise<SteeringSet> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException({ error: 'set_not_found' });
    const s = await this.d.repo.get(id);
    if (!s) throw new NotFoundException({ error: 'set_not_found' });
    return s;
  }
}

/** A set without the snapshot, with counts, for lists. */
function brief(s: SteeringSet) {
  const { posts, metrics: _m, ...rest } = s;
  return {
    ...rest,
    postCount: posts.length,
    rulesTotal: s.rules.length,
    rulesActive: s.rules.filter((r) => r.enabled && !r.conflict).length,
    conflicts: s.rules.filter((r) => r.conflict).length,
  };
}
