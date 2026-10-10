import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import type { EditorCard } from '../card';
import type { AgentLoopResult } from '../harness/agent-loop';
import type { ToolRegistry } from '../harness/tool-registry';
import { toToolSpec } from '../harness/tool';
import type { EditorRole, ToolSpec } from '../llm/llm.types';
import type { EditorChannelsRepository } from '../repo/editor-channels.repository';
import type { EditorPlansRepository, EditorSlot, SlotStatus } from '../repo/editor-plans.repository';
import type { EditorMemoryRepository } from '../repo/editor-memory.repository';
import type { EditorRunsRepository, SpendRow } from '../repo/editor-runs.repository';
import type { EditorRunnerService } from '../roles/editor-runner.service';
import { localDate } from '../roles/time';
import { previewWithoutRun, type SlotPreview } from '../roles/preview-run';
import { mergeCard } from './card-input';

export interface EditorOpsDeps {
  channels: Pick<EditorChannelsRepository, 'get' | 'list' | 'upsert'>;
  plans:    Pick<EditorPlansRepository, 'listPlans' | 'slotStatusCounts' | 'getSlot' | 'claimSlot' | 'skipPlannedSlot'>
    & Partial<Pick<EditorPlansRepository, 'planOf' | 'claimPreview' | 'setPreview'>>;
  memory:   Pick<EditorMemoryRepository, 'listAll' | 'add' | 'retireByOwner'>;
  runs:     Pick<EditorRunsRepository, 'list' | 'get' | 'spendByDay'> & Partial<Pick<EditorRunsRepository, 'previewEstimates'>>;
  runner:   Pick<EditorRunnerService, 'runPlanner' | 'runExecutor'> & Partial<Pick<EditorRunnerService, 'runPreview'>>;
  registry: Pick<ToolRegistry, 'all' | 'get'>;
  skills:   { list(): Array<{ name: string }> };
  enabled:  () => boolean;
  now?:     () => Date;
  log?:     (msg: string) => void;
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
    void job().catch((err) => this.d.log?.(`${label} failed: ${err?.message ?? err}`));
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

  async getChannel(key: string) {
    const card = await this.card(key);
    const { channels } = await this.listChannels();
    return channels.find((c) => c.channelKey === key) ?? card;
  }

  async upsertChannel(key: string, body: unknown) {
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
    return this.d.channels.upsert(merged.card);
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
  async replan(key: string, opts: RunOptions & { date?: string }): Promise<RunOutcome> {
    this.requireEnabled();
    const card = await this.card(key);
    this.requireNotOff(card);
    const day = opts.date || 'today';
    if (day !== 'today' && day !== 'tomorrow') throw new BadRequestException({ error: 'invalid_param', field: 'date', details: 'today or tomorrow' });
    const planDate = day === 'tomorrow' ? localDate(new Date(this.now().getTime() + 86_400_000), card.timezone) : undefined;
    if (this.replanning.has(key)) throw new ConflictException({ error: 'replan_in_progress' });
    this.replanning.add(key);
    const job = () => this.d.runner.runPlanner(card, planDate ? { planDate } : {}).finally(() => this.replanning.delete(key));
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
        result = previewWithoutRun('failed', `preview failed: ${String(err?.message ?? err).slice(0, 300)}`, startedAt);
      }
      try {
        await this.d.plans.setPreview!(id, result);
      } finally {
        this.previewing.delete(id);
      }
      return result;
    };
    if (opts.wait) return { started: true, slotId: id, preview: await job() };
    void job().catch((err) => { this.previewing.delete(id); this.d.log?.(`preview of slot ${id} failed: ${err?.message ?? err}`); });
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
    const id = await this.d.memory.add(key, p.data.kind, p.data.text, null, 'owner');
    return { id };
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
      return { result: { error: 'tool_failed', details: String(err?.message ?? err) } };
    }
  }
}
