import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { EditorRunRow } from '../repo/editor-runs.repository';
import type { MemoryEntry } from '../repo/editor-memory.repository';
import { Agent, isPaused, telegramKeyOf, validateHandle } from './agent.types';
import type { AgentPatch, AgentsRepository } from './agents.repository';
import type { OwnerInbox } from './owner-inbox';
import type { SkillStore } from './skill-store';
import { SKILL_ROLES } from './skill-lint';

export interface AgentsServiceDeps {
  pool:    Pick<Pool, 'query'>;
  agents:  AgentsRepository;
  skills:  SkillStore;
  inbox:   OwnerInbox;
  /** Channel mode changes go through the editor ops (audit row, validation). */
  setChannelMode: (channelKey: string, mode: 'off' | 'shadow' | 'live') => Promise<unknown>;
  /** "Run now" per kind; each returns at once (the run continues in the background). */
  runNow: (agent: Agent, orchestrator: Agent) => Promise<{ started: boolean; what: string }>;
  memory: (channelKey: string) => Promise<MemoryEntry[]>;
  /** Registry sync (cards → orchestrators); run before listing so a new card shows its agent at once. */
  sync?:  () => Promise<unknown>;
  log?:   (msg: string) => void;
  now?:   () => Date;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const PatchSchema = z.object({
  name:             z.string().trim().min(1).max(60).optional(),
  handle:           z.string().trim().toLowerCase().transform((s) => s.replace(/^@/, '')).optional(),
  emoji:            z.string().trim().max(8).nullable().optional(),
  description:      z.string().trim().max(500).nullable().optional(),
  mode:             z.enum(['off', 'shadow', 'live']).optional(),
  status:           z.enum(['active', 'paused']).optional(),
  paused_until:     z.string().datetime({ offset: true }).nullable().optional(),
  model:            z.string().trim().min(3).max(100).nullable().optional(),
  reasoning_effort: z.enum(['low', 'medium', 'high']).nullable().optional(),
  schedule:         z.object({ times: z.array(z.string().regex(TIME_RE)).max(8).optional() }).optional(),
  daily_budget_usd: z.number().min(0).max(50).nullable().optional(),
}).strict();

const SkillBodySchema = z.object({
  description: z.string().trim().min(10).max(300),
  applies_to:  z.array(z.enum(SKILL_ROLES as unknown as [string, ...string[]])).min(1),
  body:        z.string().min(1).max(12_000),
  force:       z.boolean().optional(),
}).strict();

const SkillToggleSchema = z.object({
  enabled: z.boolean().optional(),
  inline:  z.boolean().optional(),
  locked:  z.boolean().optional(),
}).strict();

export interface AgentNode extends Agent {
  activity: { spentTodayUsd: number; lastRunAt: Date | null; lastStatus: string | null; runsToday: number };
  paused:   boolean;
  children: AgentNode[];
}

const badRequest = (r: z.ZodError) => new BadRequestException({ error: 'invalid_body', issues: r.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });

/** The owner surface of the agent registry (spec 017 FR-010). */
export class AgentsService {
  constructor(private readonly d: AgentsServiceDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  async require(handle: string): Promise<Agent> {
    const a = await this.d.agents.getByHandle(handle);
    if (!a) throw new NotFoundException({ error: 'agent_not_found', handle });
    return a;
  }

  private async orchestratorOf(a: Agent): Promise<Agent> {
    return a.parentId ? ((await this.d.agents.get(a.parentId)) ?? a) : a;
  }

  /** manager → builder → orchestrators (with role children), each with today's activity. */
  async tree(): Promise<{ agents: AgentNode[] }> {
    if (this.d.sync) {
      try { await this.d.sync(); } catch (err: any) { this.d.log?.(`agent registry sync failed: ${err?.message ?? err}`); }
    }
    const [all, act] = await Promise.all([this.d.agents.list(), this.d.agents.activity()]);
    const now = this.now();
    const empty = { spentTodayUsd: 0, lastRunAt: null, lastStatus: null, runsToday: 0 };
    const node = (a: Agent): AgentNode => ({
      ...a, activity: act.get(a.id) ?? empty, paused: isPaused(a, now),
      children: all.filter((c) => c.parentId === a.id).map(node),
    });
    const order = { manager: 0, builder: 1, orchestrator: 2 } as Record<string, number>;
    return { agents: all.filter((a) => !a.parentId).sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.handle.localeCompare(b.handle)).map(node) };
  }

  async get(handle: string) {
    const a = await this.require(handle);
    const orch = await this.orchestratorOf(a);
    const [children, act] = await Promise.all([this.d.agents.children(a.id), this.d.agents.activity()]);
    const parent = a.parentId ? orch : null;
    return {
      agent: { ...a, paused: isPaused(a, this.now()), activity: act.get(a.id) ?? null },
      parent: parent ? { id: parent.id, handle: parent.handle, name: parent.name, emoji: parent.emoji } : null,
      children: children.map((c) => ({ ...c, activity: act.get(c.id) ?? null })),
      channelKey: telegramKeyOf(orch),
    };
  }

  async patch(handle: string, body: unknown) {
    const a = await this.require(handle);
    const p = PatchSchema.safeParse(body ?? {});
    if (!p.success) throw badRequest(p.error);
    const v = p.data;
    const patch: AgentPatch = {};
    if (v.name !== undefined) patch.name = v.name;
    if (v.handle !== undefined && v.handle !== a.handle) {
      const err = validateHandle(v.handle);
      if (err) throw new BadRequestException({ error: 'invalid_handle', details: err });
      if (await this.d.agents.handleTaken(v.handle, a.id)) throw new ConflictException({ error: 'handle_taken', handle: v.handle });
      patch.handle = v.handle;
    }
    if (v.emoji !== undefined) patch.emoji = v.emoji || null;
    if (v.description !== undefined) patch.description = v.description || null;
    if (v.status !== undefined) patch.status = v.status;
    if (v.paused_until !== undefined) {
      const until = v.paused_until ? new Date(v.paused_until) : null;
      if (until && (until.getTime() <= this.now().getTime() || until.getTime() > this.now().getTime() + 90 * 86_400_000)) {
        throw new BadRequestException({ error: 'invalid_paused_until', details: 'у майбутньому, не далі 90 днів' });
      }
      patch.pausedUntil = until;
    }
    if (v.model !== undefined) patch.model = v.model;
    if (v.reasoning_effort !== undefined) patch.reasoningEffort = v.reasoning_effort;
    if (v.schedule !== undefined) patch.schedule = v.schedule;
    if (v.daily_budget_usd !== undefined) patch.dailyBudgetUsd = v.daily_budget_usd;
    if (v.mode !== undefined && v.mode !== a.mode) {
      // A Telegram resource orchestrator's mode IS the channel card's mode (the publishing switch).
      const key = !a.parentId ? telegramKeyOf(a) : null;
      if (key) await this.d.setChannelMode(key, v.mode);
      patch.mode = v.mode;
      if (v.mode === 'live') patch.shadowUntil = null;
    }
    const updated = await this.d.agents.update(a.id, patch);
    return { agent: updated };
  }

  async runNow(handle: string) {
    const a = await this.require(handle);
    if (isPaused(a, this.now())) throw new ConflictException({ error: 'agent_paused' });
    const orch = await this.orchestratorOf(a);
    return this.d.runNow(a, orch);
  }

  /** Runs of the agent and its role children, newest first; `before` is a cursor (ISO time). */
  async runs(handle: string, before?: string, limit = 50): Promise<{ runs: Array<EditorRunRow & { agentId: string | null }> }> {
    const a = await this.require(handle);
    const kids = await this.d.agents.children(a.id);
    const ids = [a.id, ...kids.map((k) => k.id)];
    const { rows } = await this.d.pool.query(
      `SELECT * FROM editor_runs WHERE agent_id = ANY($1::uuid[]) AND ($2::timestamptz IS NULL OR started_at < $2)
        ORDER BY started_at DESC LIMIT $3`, [ids, before ?? null, Math.min(Math.max(limit, 1), 200)]);
    return {
      runs: rows.map((r) => ({
        id: r.id, role: r.role, channelKey: r.channel_key ?? null, slotId: r.slot_id ?? null, model: r.model, status: r.status,
        steps: Number(r.steps), promptTokens: Number(r.prompt_tokens), completionTokens: Number(r.completion_tokens),
        costUsd: Number(r.cost_usd), error: r.error ?? null, startedAt: r.started_at, finishedAt: r.finished_at ?? null, agentId: r.agent_id ?? null,
      })),
    };
  }

  // ── skills ────────────────────────────────────────────────────────────────

  private async chain(a: Agent): Promise<string[]> {
    return a.parentId ? [a.id, a.parentId] : [a.id];
  }

  async listSkills(handle: string) {
    const a = await this.require(handle);
    return { skills: await this.d.skills.listForAgent(await this.chain(a)) };
  }

  /** Owner writes a skill for this agent: a new own skill or an override of a shared one. */
  async putSkill(handle: string, name: string, body: unknown) {
    const a = await this.require(handle);
    const p = SkillBodySchema.safeParse(body ?? {});
    if (!p.success) throw badRequest(p.error);
    const shared = await this.d.skills.findShared(name);
    if (shared?.safety && !p.data.force) {
      throw new ConflictException({ error: 'safety_skill', details: 'це системний скіл безпеки — підтвердіть force: true, якщо розумієте наслідки' });
    }
    const r = await this.d.skills.writeAgentSkill({
      agentId: a.id, name, description: p.data.description, appliesTo: p.data.applies_to, body: p.data.body,
      author: 'owner', force: p.data.force, reason: 'owner edit',
    });
    if ('error' in r) throw new BadRequestException(r);
    return r;
  }

  async patchSkill(handle: string, name: string, body: unknown) {
    const a = await this.require(handle);
    const p = SkillToggleSchema.safeParse(body ?? {});
    if (!p.success) throw badRequest(p.error);
    const skill = (await this.d.skills.findForAgent(a.id, name)) ?? (await this.d.skills.findShared(name));
    if (!skill) throw new NotFoundException({ error: 'skill_not_found', name });
    if (p.data.enabled !== undefined || p.data.inline !== undefined) {
      await this.d.skills.setToggle(a.id, skill.id, { enabled: p.data.enabled, inline: p.data.inline });
    }
    if (p.data.locked !== undefined) {
      if (skill.scope === 'builtin') throw new BadRequestException({ error: 'builtin_lock', details: 'вбудований скіл не блокується; заблокуйте перевизначення агента' });
      await this.d.skills.setLocked(skill.id, p.data.locked);
    }
    return this.listSkills(handle);
  }

  /** Remove the agent's override ("reset to default") or its own skill. */
  async deleteSkill(handle: string, name: string) {
    const a = await this.require(handle);
    if (!(await this.d.skills.deleteAgentSkill(a.id, name))) throw new NotFoundException({ error: 'skill_not_found', name });
    return { ok: true };
  }

  async versions(skillId: string) {
    const skill = await this.d.skills.get(skillId);
    if (!skill) throw new NotFoundException({ error: 'skill_not_found' });
    return { skill, versions: await this.d.skills.versions(skillId) };
  }

  async rollback(skillId: string, body: unknown) {
    const p = z.object({ version: z.number().int().min(1) }).strict().safeParse(body ?? {});
    if (!p.success) throw badRequest(p.error);
    const r = await this.d.skills.rollback(skillId, p.data.version, 'owner', `owner rollback to v${p.data.version}`);
    if ('error' in r) throw new BadRequestException(r);
    return r;
  }

  async memory(handle: string) {
    const a = await this.require(handle);
    const key = telegramKeyOf(await this.orchestratorOf(a));
    return { channelKey: key, memory: key ? await this.d.memory(key) : [] };
  }

  // ── inbox ─────────────────────────────────────────────────────────────────

  async inbox(unread?: boolean) {
    return { items: await this.d.inbox.list({ unreadOnly: !!unread, limit: 200 }) };
  }

  async markRead(body: unknown) {
    const p = z.object({ ids: z.union([z.array(z.number().int().positive()).max(500), z.literal('all')]) }).strict().safeParse(body ?? {});
    if (!p.success) throw badRequest(p.error);
    return { marked: await this.d.inbox.markRead(p.data.ids) };
  }
}
