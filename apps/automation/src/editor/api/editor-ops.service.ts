import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import type { EditorCard } from '../card';
import type { AgentLoopResult } from '../harness/agent-loop';
import type { ToolRegistry } from '../harness/tool-registry';
import { toToolSpec } from '../harness/tool';
import type { EditorRole, ToolSpec } from '../llm/llm.types';
import type { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { isPlaceholderPlan, type EditorPlansRepository, type EditorSlot, type SlotStatus } from '../repo/editor-plans.repository';
import type { EditorMemoryRepository } from '../repo/editor-memory.repository';
import type { EditorRunsRepository, SpendRow } from '../repo/editor-runs.repository';
import type { EditorRunnerService } from '../roles/editor-runner.service';
import { localDate, localHour } from '../roles/time';
import { previewWithoutRun, type SlotPreview } from '../roles/preview-run';
import { mergeCard } from './card-input';
import type { StyleProposal } from '../post/style/style-proposal';
import { conflictNote, newConflictsOf, type ConflictNote } from '../rules/config-conflicts';
import { errText } from '../../common/err-text';
import { changedCardSources, probeInBackground, type BackgroundProbe } from '../sources/probe-triggers';

export interface EditorOpsDeps {
  channels: Pick<EditorChannelsRepository, 'get' | 'list' | 'upsert'>;
  plans:    Pick<EditorPlansRepository, 'listPlans' | 'slotStatusCounts' | 'getSlot' | 'claimSlot' | 'skipPlannedSlot'>
    & Partial<Pick<EditorPlansRepository, 'planOf' | 'claimPreview' | 'setPreview' | 'getActivePlan' | 'listSlots'>>;
  memory:   Pick<EditorMemoryRepository, 'listAll' | 'add' | 'retireByOwner'>;
  runs:     Pick<EditorRunsRepository, 'list' | 'get' | 'spendByDay'> & Partial<Pick<EditorRunsRepository, 'previewEstimates'>>;
  runner:   Pick<EditorRunnerService, 'runPlanner' | 'runExecutor'> & Partial<Pick<EditorRunnerService, 'runPreview'>>;
  registry: Pick<ToolRegistry, 'all' | 'get'>;
  skills:   { list(): Array<{ name: string }> };
  enabled:  () => boolean;
  now?:     () => Date;
  log?:     (msg: string) => void;
  /** Spec 037 FR-008: the style bootstrap proposal of a resource (read-only; absent = 503). */
  styleProposal?: (ref: string) => Promise<StyleProposal>;
  /** Spec 073 FR-012: the owner-rule lint (the Rules artifact's); absent = the form stores a rule as it did. */
  lint?: (text: string, channelKey: string) => Promise<Array<{ code: string; detail: string }>>;
  /** Spec 073 FR-012: the channel's rules-vs-config conflicts (`ConfigConflictsService.forAgent`); absent = none are reported. */
  conflicts?: (channelKey: string) => Promise<ConflictNote[]>;
  /** Spec 076 FR-004: the server reads each new or changed feed / page source of a saved card in the background (the save does not wait). */
  probe?: BackgroundProbe;
}

export interface RunOptions { wait?: boolean }

export interface RunOutcome {
  started: true;
  slotId?: string;
  result?: Pick<AgentLoopResult, 'runId' | 'status' | 'terminalTool' | 'terminalResult' | 'error'>;
}

/** Spec 034 FR-012: `POST /api/editor/slots/:id/preview` — `preview` is the finished result with `?wait=true`, else `running`. */
export interface PreviewOutcome {
  started: true;
  slotId:  string;
  preview: SlotPreview;
}

const KYIV = 'Europe/Kyiv';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MemoryInput = z.object({
  kind: z.enum(['insight', 'rule', 'avoid']),
  text: z.string().trim().min(3).max(1000),
}).strict();

const ToolCallInput = z.object({
  channel: z.string().min(1).max(200),
  role:    z.enum(['planner', 'executor', 'reviewer']).optional(),
  input:   z.unknown().optional(),
}).strict();

const intParam = (v: string | number | undefined, def: number, min: number, max: number, field: string) => {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new BadRequestException({ error: 'invalid_param', field });
  return Math.min(max, Math.max(min, n));
};

/** Longest owner instruction a replan takes (spec 103 §7). */
export const REPLAN_INSTRUCTION_MAX = 600;

/** The planner prompt block of an owner instruction: bounded, one block, and not a way to change rules or modes. */
export function ownerInstruction(raw: string | undefined | null): string | null {
  const t = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, REPLAN_INSTRUCTION_MAX);
  if (!t) return null;
  return `Owner instruction for this plan (plan around it; it cannot change the channel's rules, mode or budget):\n«${t}»`;
}

const brief = (r: AgentLoopResult): RunOutcome['result'] => ({
  runId: r.runId, status: r.status, terminalTool: r.terminalTool, terminalResult: r.terminalResult, error: r.error,
});

/**
 * Owner/ops operations behind /api/editor (spec 006). Every action that makes
 * the editor do something goes through EditorRunnerService, so the exact same
 * tools and publish guards apply as for scheduled runs (constitution I).
 */
export class EditorOpsService {
  private readonly replanning = new Set<string>();

  constructor(private readonly d: EditorOpsDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  private async card(key: string): Promise<EditorCard & { createdAt: Date }> {
    const card = await this.d.channels.get(key);
    if (!card) throw new NotFoundException({ error: 'channel_not_found', channel: key });
    return card;
  }

  private requireEnabled(): void {
    if (!this.d.enabled()) throw new ServiceUnavailableException({ error: 'editor_disabled', details: 'EDITOR_ENABLED is not true' });
  }

  private requireNotOff(card: EditorCard): void {
    if (card.mode === 'off') throw new ConflictException({ error: 'channel_off', details: 'switch the channel to shadow or live first' });
  }

  /** Kick off `job`: await it when asked to, otherwise run it in the background and log failures. */
  private async start(job: () => Promise<AgentLoopResult>, opts: RunOptions, label: string): Promise<AgentLoopResult | null> {
    if (opts.wait) return job();
    void job().catch((err) => this.d.log?.(`${label} failed: ${errText(err)}`));
    return null;
  }

  // ── channels ──────────────────────────────────────────────────────────────

  async listChannels() {
    const now = this.now();
    const cards = await this.d.channels.list();
    const [counts, spend] = await Promise.all([
      this.d.plans.slotStatusCounts(localDate(new Date(now.getTime() - 86_400_000), KYIV)),
      this.d.runs.spendByDay(1),
    ]);
    const today = localDate(now, KYIV);
    return {
      enabled:  this.d.enabled(),
      date:     today,
      channels: cards.map((c) => {
        const date = localDate(now, c.timezone);
        const slots: Partial<Record<SlotStatus, number>> = {};
        for (const x of counts) if (x.channelKey === c.channelKey && x.planDate === date) slots[x.status] = x.n;
        const s = spend.find((r) => r.channelKey === c.channelKey && r.day === today);
        return { ...c, today: { date, spendUsd: s?.usd ?? 0, runs: s?.runs ?? 0, slots } };
      }),
    };
  }

  /**
   * Spec 037 FR-008: a style sheet proposal from the resource's posts of the last 60 days (names policy; hashtag
   * vocabulary only in vocabulary mode). Nothing is applied: the owner accepts it in the Formatting section.
   */
  async styleProposal(ref: string | undefined) {
    const r = (ref ?? '').trim();
    if (!/^[a-z]+:\S{1,200}$/.test(r)) throw new BadRequestException({ error: 'invalid_ref', details: 'expected <platform>:<id>, e.g. telegram:@channel' });
    if (!this.d.styleProposal) throw new ServiceUnavailableException({ error: 'style_proposal_unavailable' });
    return this.d.styleProposal(r);
  }

  async getChannel(key: string) {
    const card = await this.card(key);
    const { channels } = await this.listChannels();
    return channels.find((c) => c.channelKey === key) ?? card;
  }

  /**
   * Save a channel's card. Spec 073 FR-004 (A25): when the owner switches a channel back on (`off` → any other mode) past its
   * plan hour and today's plan has nothing left to run, the day's replan starts — not awaited, errors logged, the save
   * never fails because of it. `opts.replan: false` opts out (launch's Start plans by itself).
   */
  async upsertChannel(key: string, body: unknown, opts: { replan?: boolean } = {}) {
    const channelKey = (key ?? '').trim();
    if (!channelKey || channelKey.length > 200) throw new BadRequestException({ error: 'invalid_channel_key' });
    const existing = await this.d.channels.get(channelKey);
    const merged = mergeCard(channelKey, existing, body);
    if (!merged.ok) throw new BadRequestException({ error: 'invalid_card', issues: merged.issues });

    const knownSkills = new Set(this.d.skills.list().map((s) => s.name));
    const unknownSkills = merged.card.skills.filter((s) => !knownSkills.has(s));
    const unknownTools = (merged.card.toolsAllow ?? []).filter((t) => !this.d.registry.get(t));
    if (unknownSkills.length || unknownTools.length) {
      throw new BadRequestException({ error: 'invalid_card', unknownSkills, unknownTools });
    }
    const saved = await this.d.channels.upsert(merged.card);
    // Spec 076 FR-004 / A30: only a source that is new or changed against the card as it was; a mode-only save probes nothing.
    probeInBackground(this.d.probe, changedCardSources(existing?.sources, merged.card.sources), this.d.log);
    if (opts.replan !== false) await this.replanAfterSwitchOn(saved.card, saved.previousMode);
    return saved;
  }

  /** A25: start the day's replan after `off` → on when today's plan is real and nothing is left to run. Never throws. */
  private async replanAfterSwitchOn(card: EditorCard, previousMode: EditorCard['mode'] | null): Promise<void> {
    try {
      if (previousMode !== 'off' || card.mode === 'off') return;
      const { getActivePlan, listSlots } = this.d.plans;
      if (!getActivePlan || !listSlots) return;
      const now = this.now();
      if (localHour(now, card.timezone) < card.planHour) return;
      // No plan today, or only a placeholder: the scheduler's `maybePlan` plans it on its next tick (never two planners).
      const plan = await getActivePlan.call(this.d.plans, card.channelKey, localDate(now, card.timezone));
      if (!plan || isPlaceholderPlan(plan.rationale)) return;
      const slots = await listSlots.call(this.d.plans, card.channelKey, plan.id);
      if (slots.some((x) => x.kind === 'content' && x.status === 'planned' && x.scheduledAt.getTime() > now.getTime())) return;
      void this.replan(card.channelKey, { wait: false }).catch((err) => this.d.log?.(`replan after switching ${card.channelKey} on skipped: ${err?.getResponse?.()?.error ?? errText(err)}`));
    } catch (err) {
      this.d.log?.(`replan check after switching ${card.channelKey} on failed: ${errText(err)}`);
    }
  }

  // ── plans and slots ───────────────────────────────────────────────────────

  /**
   * Plans of a date: the active one first, then the superseded ones (plan history) — each with when and by which
   * run it was made (`createdAt`, `runId`, `runRole`). `previewEstimates`: the typical USD of one slot Preview per
   * channel (spec 034 FR-012; absent without executor history).
   */
  async listPlans(date?: string, channel?: string) {
    const planDate = date || localDate(this.now(), KYIV);
    if (!DATE_RE.test(planDate)) throw new BadRequestException({ error: 'invalid_date', details: 'expected YYYY-MM-DD' });
    const plans = await this.d.plans.listPlans(planDate, channel || null);
    const keys = [...new Set(plans.map((p) => p.channelKey))];
    const est = this.d.runs.previewEstimates ? await this.d.runs.previewEstimates(keys).catch(() => new Map<string, number>()) : new Map<string, number>();
    return { date: planDate, plans, previewEstimates: Object.fromEntries(est) };
  }

  /**
   * Spec 034 FR-011: a partial replan — the planner replaces only the future planned slots of the day;
   * running, written, approved, pinned and reserved slots stay. `date`: 'today' (the rest of today, the
   * default) or 'tomorrow' (approval mode plans the next day the evening before).
   */
  async replan(key: string, opts: RunOptions & { date?: string; instruction?: string }): Promise<RunOutcome> {
    this.requireEnabled();
    const card = await this.card(key);
    this.requireNotOff(card);
    const day = opts.date || 'today';
    if (day !== 'today' && day !== 'tomorrow') throw new BadRequestException({ error: 'invalid_param', field: 'date', details: 'today or tomorrow' });
    const planDate = day === 'tomorrow' ? localDate(new Date(this.now().getTime() + 86_400_000), card.timezone) : undefined;
    if (this.replanning.has(key)) throw new ConflictException({ error: 'replan_in_progress' });
    this.replanning.add(key);
    // Spec 103: the owner's instruction (from Claude) is bounded and framed as data the planner weighs, never as a command.
    const extra = ownerInstruction(opts.instruction);
    const job = () => this.d.runner.runPlanner(card, { ...(planDate ? { planDate } : {}), ...(extra ? { extra } : {}) }).finally(() => this.replanning.delete(key));
    const res = await this.start(job, opts, `replan ${key}`);
    return res ? { started: true, result: brief(res) } : { started: true };
  }

  async getSlot(id: string): Promise<EditorSlot> {
    const slot = await this.d.plans.getSlot(id);
    if (!slot) throw new NotFoundException({ error: 'slot_not_found' });
    return slot;
  }

  /**
   * The slot page (spec 034 FR-012): the slot with its plan (when and by which run it was made) and the typical
   * cost of a Preview on its channel.
   */
  async slotDetail(id: string) {
    const slot = await this.getSlot(id);
    const [plan, est] = await Promise.all([
      this.d.plans.planOf ? this.d.plans.planOf(slot.planId).catch(() => null) : Promise.resolve(null),
      this.d.runs.previewEstimates ? this.d.runs.previewEstimates([slot.channelKey]).catch(() => new Map<string, number>()) : Promise.resolve(new Map<string, number>()),
    ]);
    return { ...slot, plan, previewEstimateUsd: est.get(slot.channelKey) ?? null };
  }

  private readonly previewing = new Set<string>();

  /**
   * Spec 034 FR-012: the owner's on-demand Preview of a fixed planned slot — the executor in dry mode (every guard
   * and the critic; no publish, no approval card, nothing in the content ledger; the slot keeps its status). The
   * result is stored as the slot's `previewDraft`. One preview at a time per slot (`preview_in_progress`). Spend
   * counts as `editor.preview` (+ `editor.checker`) and stops at the blocking caps like every run.
   */
  async previewSlot(id: string, opts: RunOptions): Promise<PreviewOutcome> {
    this.requireEnabled();
    if (!this.d.runner.runPreview || !this.d.plans.claimPreview || !this.d.plans.setPreview) {
      throw new ServiceUnavailableException({ error: 'preview_unavailable' });
    }
    const slot = await this.getSlot(id);
    const card = await this.card(slot.channelKey);
    this.requireNotOff(card);
    if (slot.kind !== 'content') throw new ConflictException({ error: 'slot_not_runnable', details: 'reserved slots are not written by the editor' });
    if (slot.status !== 'planned') throw new ConflictException({ error: 'slot_not_planned', status: slot.status, details: 'a written slot shows its post; Preview is for planned slots' });
    if (slot.topicMode === 'live') {
      throw new ConflictException({ error: 'preview_live_slot', details: 'a live slot picks the freshest item at its time; its description is the preview' });
    }
    if (slot.treatment === 'duplicate' || slot.treatment === 'adapt') {
      throw new ConflictException({ error: 'preview_derived_slot', details: `a ${slot.treatment} is written from its source once the source is written` });
    }
    if (this.previewing.has(id)) throw new ConflictException({ error: 'preview_in_progress' });
    const claimed = await this.d.plans.claimPreview(id, this.now());
    if (!claimed) {
      const now = await this.d.plans.getSlot(id);
      if (now?.status !== 'planned') throw new ConflictException({ error: 'slot_not_planned', status: now?.status ?? slot.status });
      throw new ConflictException({ error: 'preview_in_progress' });
    }
    this.previewing.add(id);
    const startedAt = claimed.previewDraft?.startedAt ?? this.now().toISOString();
    const job = async (): Promise<SlotPreview> => {
      let result: SlotPreview;
      try {
        result = await this.d.runner.runPreview!(claimed, card);
      } catch (err: any) {
        result = previewWithoutRun('failed', `preview failed: ${errText(err).slice(0, 300)}`, startedAt);
      }
      try {
        await this.d.plans.setPreview!(id, result);
      } finally {
        this.previewing.delete(id);
      }
      return result;
    };
    if (opts.wait) return { started: true, slotId: id, preview: await job() };
    void job().catch((err) => { this.previewing.delete(id); this.d.log?.(`preview of slot ${id} failed: ${errText(err)}`); });
    return { started: true, slotId: id, preview: claimed.previewDraft! };
  }

  /**
   * "Run now": the slot is claimed exactly like the scheduler does (planned →
   * running, attempts+1) and then handed to the normal executor, so every
   * publish guard (mode, lint, dedup, cap, quiet hours, min gap) still applies.
   */
  async runSlot(id: string, opts: RunOptions): Promise<RunOutcome> {
    this.requireEnabled();
    const slot = await this.getSlot(id);
    const card = await this.card(slot.channelKey);
    this.requireNotOff(card);
    if (slot.kind !== 'content') throw new ConflictException({ error: 'slot_not_runnable', details: 'reserved slots are not executed by the editor' });
    const claimed = await this.d.plans.claimSlot(id);
    if (!claimed) {
      const now = await this.d.plans.getSlot(id);
      throw new ConflictException({ error: 'slot_not_planned', status: now?.status ?? slot.status });
    }
    const res = await this.start(() => this.d.runner.runExecutor(claimed, card), opts, `run slot ${id}`);
    return res ? { started: true, slotId: id, result: brief(res) } : { started: true, slotId: id };
  }

  async skipSlot(id: string, reason?: string): Promise<EditorSlot> {
    const slot = await this.getSlot(id);
    const text = `skipped by owner${reason?.trim() ? `: ${reason.trim().slice(0, 300)}` : ''}`;
    const skipped = await this.d.plans.skipPlannedSlot(id, text);
    if (!skipped) throw new ConflictException({ error: 'slot_not_planned', status: slot.status });
    return skipped;
  }

  // ── runs and spend ────────────────────────────────────────────────────────

  async listRuns(q: { channel?: string; slot?: string; limit?: string | number }) {
    if (q.slot && !UUID_RE.test(q.slot)) throw new BadRequestException({ error: 'invalid_param', field: 'slot' });
    return this.d.runs.list({
      channelKey: q.channel || null,
      slotId:     q.slot || null,
      limit:      intParam(q.limit, 50, 1, 200, 'limit'),
    });
  }

  async getRun(id: string) {
    const run = await this.d.runs.get(id);
    if (!run) throw new NotFoundException({ error: 'run_not_found' });
    return run;
  }

  async spend(daysParam?: string | number): Promise<{ days: number; totalUsd: number; rows: SpendRow[] }> {
    const days = Number(daysParam ?? 30);
    if (!Number.isInteger(days) || days < 1 || days > 366) throw new BadRequestException({ error: 'invalid_param', field: 'days' });
    const rows = await this.d.runs.spendByDay(days);
    const totalUsd = Math.round(rows.reduce((s, r) => s + r.usd, 0) * 1e6) / 1e6;
    return { days, totalUsd, rows };
  }

  // ── memory ────────────────────────────────────────────────────────────────

  async listMemory(key: string) {
    await this.card(key);
    return this.d.memory.listAll(key);
  }

  async addMemory(key: string, body: unknown) {
    const p = MemoryInput.safeParse(body);
    if (!p.success) throw new BadRequestException({ error: 'invalid_memory', issues: p.error.issues });
    await this.card(key);
    // Spec 073 FR-012: a rule or an avoid goes through the same lint as the Rules artifact; an insight is a note, not an instruction.
    const instruction = p.data.kind !== 'insight';
    if (instruction && this.d.lint) {
      const issues = await this.d.lint(p.data.text, key).catch(() => []);
      if (issues.length) throw new BadRequestException({ error: 'rule_invalid', details: issues.map((i) => `«${p.data.text.slice(0, 60)}»: ${i.detail}`) });
    }
    const before = instruction && this.d.conflicts ? await this.d.conflicts(key).catch(() => []) : [];
    const id = await this.d.memory.add(key, p.data.kind, p.data.text, null, 'owner');
    // …and the conflicts it causes with the playbook, the profiles and the card come back with the id (the form shows one line).
    const after = instruction && this.d.conflicts ? await this.d.conflicts(key).catch(() => []) : [];
    const conflicts = newConflictsOf(before, after, [id]).map(conflictNote);
    return { id, ...(conflicts.length ? { conflicts } : {}) };
  }

  async retireMemory(key: string, id: number) {
    if (!Number.isInteger(id) || id < 1) throw new BadRequestException({ error: 'invalid_id' });
    const ok = await this.d.memory.retireByOwner(key, id);
    if (!ok) throw new NotFoundException({ error: 'memory_not_found' });
    return { ok: true };
  }

  // ── tools (the MCP server reuses the editor's read tools through these) ──

  /** Read tools only: nothing here can publish or write. */
  listTools(): Array<ToolSpec & { roles: EditorRole[] }> {
    return this.d.registry.all().filter((t) => t.kind === 'read').map((t) => ({ ...toToolSpec(t), roles: t.roles }));
  }

  async callTool(name: string, body: unknown): Promise<{ result: unknown }> {
    const tool = this.d.registry.get(name);
    if (!tool || tool.kind !== 'read') throw new NotFoundException({ error: 'tool_not_found', details: 'only read tools are exposed' });
    const b = ToolCallInput.safeParse(body ?? {});
    if (!b.success) throw new BadRequestException({ error: 'invalid_body', issues: b.error.issues });
    const card = await this.card(b.data.channel);
    const args = tool.input.safeParse(b.data.input ?? {});
    if (!args.success) return { result: { error: 'invalid_arguments', details: args.error.issues } };
    const role = b.data.role ?? (tool.roles.includes('executor') ? 'executor' : tool.roles[0]);
    try {
      const result = await tool.execute(args.data, { runId: 'ops', role, channelKey: card.channelKey, extras: { card } });
      return { result };
    } catch (err: any) {
      return { result: { error: 'tool_failed', details: errText(err) } };
    }
  }
}
