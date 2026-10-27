import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { agentModelIn, type Workspace } from '../llm/workspace';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { EditorRunRow } from '../repo/editor-runs.repository';
import type { MemoryEntry } from '../repo/editor-memory.repository';
import { ownerRulesOf } from '../rules/owner-rules-prompt';
import { Agent, AgentMode, isPaused, telegramKeyOf, validateHandle } from './agent.types';
import type { AgentPatch, AgentsRepository } from './agents.repository';
import type { OwnerInbox } from './owner-inbox';
import type { PendingActionsService } from './pending-actions';
import { FORMAT_CHANGES_PER_DAY, FormatLocksSchema, FormatPrefsSchema, ResourceProfileSchema, ResourceProfilesRepository } from './resource-profile';
import { NetworkRepository } from '../network/network.repository';
import type { SkillStore } from './skill-store';
import { SELF_EDIT_REVIEW_DAYS } from './agent-skill-tools';
import { SKILL_ROLES } from './skill-lint';
import { assertNoEnabledBindings, liveRefsOf } from '../migration/binding-guard';
import { resourceStyleOf } from '../post/style/style-store';
import { defaultAppliesTo } from '../skills/skill-defaults';
import { attachProfileTone } from '../skills/profile-tone';
import { dismissHealth } from '../platform/resource-health.service';
import type { SourceHealthReport } from '../sources/source-health';
import { errText } from '../../common/err-text';
import type { SeriesPauseActions } from '../series-pause/pause-actions';
import type { SeriesPause } from '../series-pause/series-pauses.repository';

export interface AgentsServiceDeps {
  pool:    Pick<Pool, 'query'>;
  agents:  AgentsRepository;
  skills:  SkillStore;
  inbox:   OwnerInbox;
  profiles?: ResourceProfilesRepository;
  actions?:  PendingActionsService;
  /** Channel mode changes go through the editor ops (audit row, validation). */
  setChannelMode: (channelKey: string, mode: AgentMode) => Promise<unknown>;
  /** Spec 047 FR-007: the channel card's mode (the one runs and publishing follow); absent → the orchestrator's mode. */
  channelMode?: (channelKey: string) => Promise<AgentMode | null>;
  /** "Run now" per kind; each returns at once (the run continues in the background). */
  runNow: (agent: Agent, orchestrator: Agent) => Promise<{ started: boolean; what: string }>;
  memory: (channelKey: string) => Promise<MemoryEntry[]>;
  /** Registry sync (cards → orchestrators); run before listing so a new card shows its agent at once. */
  sync?:  () => Promise<unknown>;
  /**
   * Spec 035: a new agent model must be in the model catalog (throws 400 `unknown_model`);
   * `chosen` runs after the save (prices the model in llm_prices when it has no price).
   */
  models?: {
    check(model: string, current: string | null): Promise<void>; chosen(model: string): Promise<unknown>;
    /** Spec 038: the active workspace — `model` in a PATCH is the agent's model in it (absent → openrouter). */
    workspace?(): Promise<Workspace>;
  };
  log?:   (msg: string) => void;
  now?:   () => Date;
  /** Spec 040 FR-011: rules-vs-config of the agent's orchestrator (agent page). */
  conflicts?: (orchestrator: Agent) => Promise<Array<{ code: string; ref: string; detail: string; rule_id?: number }>>;
  /** Spec 047 FR-005: everything the resolver card would fix (pending playbook, junk rules, conflicts). */
  resolver?: (orchestrator: Agent) => Promise<Array<{ key: string; kind: string; detail: string; rule_id?: number | null }>>;
  /** Spec 047 FR-004: the lint of an owner rule of this orchestrator (shown on the agent page). */
  ruleLint?: (text: string, orchestrator: Agent) => Promise<Array<{ code: string; detail: string }>>;
  /** Spec 049 FR-003: the source health of a channel card (null without a card). */
  sourceHealth?: (channelKey: string) => Promise<SourceHealthReport | null>;
  /** Spec 060 FR-001: the dead-series breaker's pauses (agent page → Paused series → Resume). */
  pauses?: Pick<SeriesPauseActions, 'list' | 'resume'>;
}

const ResumeBody = z.object({ action: z.literal('resume'), id: z.string().uuid() });

/** The dashboard's view of a pause (the repository's row, dates as ISO strings). */
function pauseView(p: SeriesPause) {
  return {
    id: p.id, key: p.key, label: p.label, cause: p.cause, reason: p.reason, streak: p.streak,
    pausedAt: p.pausedAt.toISOString(), resumedAt: p.resumedAt ? p.resumedAt.toISOString() : null, resumedBy: p.resumedBy,
  };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const PatchSchema = z.object({
  name:             z.string().trim().min(1).max(60).optional(),
  handle:           z.string().trim().toLowerCase().transform((s) => s.replace(/^@/, '')).optional(),
  emoji:            z.string().trim().max(8).nullable().optional(),
  description:      z.string().trim().max(500).nullable().optional(),
  mode:             z.enum(['off', 'shadow', 'approve', 'live']).optional(),
  status:           z.enum(['active', 'paused']).optional(),
  paused_until:     z.string().datetime({ offset: true }).nullable().optional(),
  model:            z.string().trim().min(3).max(100).nullable().optional(),
  reasoning_effort: z.enum(['low', 'medium', 'high']).nullable().optional(),
  /** Spec 047 FR-006: «я зробив» / «я зробила» (null = masculine). */
  grammatical_gender: z.enum(['masculine', 'feminine']).nullable().optional(),
  schedule:         z.object({ times: z.array(z.string().regex(TIME_RE)).max(8).optional() }).optional(),
  daily_budget_usd: z.number().min(0).max(50).nullable().optional(),
}).strict();

const SkillBodySchema = z.object({
  description: z.string().trim().min(10).max(300),
  /** Spec 040 FR-012: absent → the existing skill's roles, else the writer roles for a channel agent. */
  applies_to:  z.array(z.enum(SKILL_ROLES as unknown as [string, ...string[]])).min(1).optional(),
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
  /** Spec 047 FR-007: a role agent's runs follow its orchestrator's channel mode; its own `mode` column is not read. */
  effectiveMode?: AgentMode;
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

  /**
   * Spec 047 FR-007: the mode an orchestrator's runs really follow — the channel card's for a Telegram resource, else its
   * own. Review 2: @pdr's planner/executor showed `off` but published; older channels' roles showed `approve` but went live.
   */
  private async effectiveModeOf(orch: Agent): Promise<AgentMode> {
    const key = telegramKeyOf(orch);
    const card = key && this.d.channelMode ? await this.d.channelMode(key).catch(() => null) : null;
    return card ?? orch.mode;
  }

  /** manager → builder → orchestrators (with role children), each with today's activity. */
  async tree(): Promise<{ agents: AgentNode[] }> {
    if (this.d.sync) {
      try { await this.d.sync(); } catch (err: any) { this.d.log?.(`agent registry sync failed: ${errText(err)}`); }
    }
    const [all, act] = await Promise.all([this.d.agents.list(), this.d.agents.activity()]);
    const now = this.now();
    const empty = { spentTodayUsd: 0, lastRunAt: null, lastStatus: null, runsToday: 0 };
    const modes = new Map<string, AgentMode>();
    await Promise.all(all.filter((a) => !a.parentId && all.some((c) => c.parentId === a.id)).map(async (a) => modes.set(a.id, await this.effectiveModeOf(a))));
    const node = (a: Agent): AgentNode => ({
      ...a, activity: act.get(a.id) ?? empty, paused: isPaused(a, now),
      ...(a.parentId && modes.has(a.parentId) ? { effectiveMode: modes.get(a.parentId) } : {}),
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
    const effective = parent || children.length ? await this.effectiveModeOf(orch) : null;
    return {
      agent: { ...a, paused: isPaused(a, this.now()), activity: act.get(a.id) ?? null, ...(parent && effective ? { effectiveMode: effective } : {}) },
      parent: parent ? { id: parent.id, handle: parent.handle, name: parent.name, emoji: parent.emoji } : null,
      children: children.map((c) => ({ ...c, activity: act.get(c.id) ?? null, ...(effective ? { effectiveMode: effective } : {}) })),
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
        throw new BadRequestException({ error: 'invalid_paused_until', details: 'must be in the future, at most 90 days ahead' });
      }
      patch.pausedUntil = until;
    }
    const ws: Workspace = this.d.models?.workspace ? await this.d.models.workspace() : 'openrouter';
    const current = agentModelIn(a, ws);
    const newModel = v.model !== undefined && v.model !== null && v.model !== current ? v.model : null;
    if (newModel && this.d.models) await this.d.models.check(newModel, current);
    if (v.model !== undefined) {
      if (ws === 'anthropic') patch.anthropicModel = v.model;
      else patch.model = v.model;
    }
    if (v.reasoning_effort !== undefined) patch.reasoningEffort = v.reasoning_effort;
    if (v.grammatical_gender !== undefined) patch.grammaticalGender = v.grammatical_gender;
    if (v.schedule !== undefined) {
      // Spec 046 FR-007 (034 FR-013): only @manager runs at its times; the others follow the channel card's plan hour.
      if (a.kind !== 'manager') throw new BadRequestException({ error: 'schedule_not_used', details: 'only @manager runs at schedule times; other agents run at the channel card plan hour' });
      patch.schedule = v.schedule;
    }
    if (v.daily_budget_usd !== undefined) patch.dailyBudgetUsd = v.daily_budget_usd;
    if (v.mode !== undefined && a.parentId) {
      // Spec 047 FR-007: a role agent has no mode of its own — its runs follow the orchestrator's channel mode. Spec 064
      // FR-008: refused whatever the value (its own column may say `off` while it runs live), naming the mode it follows.
      const orch = await this.orchestratorOf(a);
      const following = await this.effectiveModeOf(orch);
      throw new BadRequestException({
        error: 'mode_follows_orchestrator',
        details: `@${a.handle} has no mode of its own: it follows @${orch.handle}, which is ${following} — switch the mode on @${orch.handle}`,
        follows: orch.handle, mode: following,
      });
    }
    if (v.mode !== undefined && v.mode !== a.mode) {
      // Spec 023 FR-012: no live switch while a strategy binding still publishes to the agent's resources.
      if (v.mode === 'live') {
        const orch = a.parentId ? (await this.d.agents.get(a.parentId)) ?? a : a;
        await assertNoEnabledBindings(this.d.pool, await liveRefsOf(this.d.pool, orch));
      }
      // A Telegram resource orchestrator's mode IS the channel card's mode (the publishing switch).
      const key = !a.parentId ? telegramKeyOf(a) : null;
      if (key) await this.d.setChannelMode(key, v.mode);
      patch.mode = v.mode;
      if (v.mode === 'live' || v.mode === 'approve') patch.shadowUntil = null;
    }
    const updated = await this.d.agents.update(a.id, patch);
    if (newModel && this.d.models) await this.d.models.chosen(newModel).catch(() => undefined);
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
      throw new ConflictException({ error: 'safety_skill', details: 'this is a system safety skill — confirm with force: true if you understand the consequences' });
    }
    const appliesTo = p.data.applies_to ?? (await this.d.skills.findForAgent(a.id, name))?.appliesTo ?? shared?.appliesTo ?? defaultAppliesTo(a);
    if (!appliesTo?.length) throw new BadRequestException({ error: 'applies_to_required', details: 'a skill of a system agent needs applies_to' });
    const r = await this.d.skills.writeAgentSkill({
      agentId: a.id, name, description: p.data.description, appliesTo, body: p.data.body,
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
      if (skill.scope === 'builtin') throw new BadRequestException({ error: 'builtin_lock', details: 'a built-in skill cannot be locked; lock the agent override instead' });
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

  /**
   * Spec 059: "Adopt anyway" — the owner makes a version the probe rejected live. It goes under the usual 7-day KPI review
   * and keeps the probe's evidence (verdict `owner_override`). Only the newest version can be adopted this way; an older
   * rejection is restored with a rollback.
   */
  async adoptRejected(skillId: string, version: number) {
    const skill = await this.d.skills.get(skillId);
    if (!skill) throw new NotFoundException({ error: 'skill_not_found' });
    const v = await this.d.skills.version(skillId, version);
    if (!v) throw new NotFoundException({ error: 'version_not_found' });
    if (v.outcome !== 'rejected') throw new ConflictException({ error: 'not_rejected', details: `version ${version} is ${v.outcome ?? 'live history'}, not a rejected one` });
    const now = this.now();
    const probe = {
      ...(v.probe ?? { samples: [], costUsd: 0 }), verdict: 'owner_override' as const,
      reason: `rejected by the probe${v.probe?.reason ? ` (${v.probe.reason})` : ''}; adopted anyway by the owner`, at: now.toISOString(),
    };
    const r = await this.d.skills.adoptVersion(skillId, version, { from: ['rejected'], probe, reviewAt: new Date(now.getTime() + SELF_EDIT_REVIEW_DAYS * 86_400_000) });
    if (!r) throw new ConflictException({ error: 'cannot_adopt', details: 'a newer version exists or the version was decided already — restore it with a rollback instead' });
    return { ok: true, skill: r, version };
  }

  /** Spec 040 FR-011: where the playbook or a profile contradicts the owner's rules (empty when none or unavailable). */
  async configConflicts(handle: string) {
    const orch = await this.orchestratorOf(await this.require(handle));
    const conflicts = this.d.conflicts ? await this.d.conflicts(orch).catch(() => []) : [];
    const items = this.d.resolver ? await this.d.resolver(orch).catch(() => []) : [];
    return {
      handle: orch.handle,
      conflicts: conflicts.map((c) => ({ code: c.code, ref: c.ref, detail: c.detail, rule_id: c.rule_id ?? null })),
      items: items.map((i) => ({ key: i.key, kind: i.kind, detail: i.detail, rule_id: i.rule_id ?? null })),
    };
  }

  /** Spec 049 FR-003: how the sources of the agent's channel card behaved (empty for an agent without a card). */
  async sources(handle: string) {
    const orch = await this.orchestratorOf(await this.require(handle));
    const key = telegramKeyOf(orch);
    const report = key && this.d.sourceHealth ? await this.d.sourceHealth(key) : null;
    return report ?? { channelKey: key, days: 0, sources: [], otherHosts: [] };
  }

  /** Spec 060 FR-001: the series of the agent's channel the breaker (or the owner) paused, and the last resumed ones. */
  async seriesPauses(handle: string) {
    const orch = await this.orchestratorOf(await this.require(handle));
    const key = telegramKeyOf(orch);
    const all = key && this.d.pauses ? await this.d.pauses.list(key, 25) : [];
    return {
      channelKey: key,
      open: all.filter((p) => !p.resumedAt).map(pauseView),
      recent: all.filter((p) => p.resumedAt).slice(0, 5).map(pauseView),
    };
  }

  /** Spec 060 FR-001: `{ action: 'resume', id }` resumes a pause of this agent's channel (`resumed_by = 'owner'`). */
  async seriesPauseAction(handle: string, body: unknown) {
    const parsed = ResumeBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ error: 'invalid_body', details: 'expected { action: "resume", id }' });
    const orch = await this.orchestratorOf(await this.require(handle));
    const key = telegramKeyOf(orch);
    if (!key || !this.d.pauses) throw new NotFoundException({ error: 'no_channel', details: 'this agent has no channel' });
    const mine = (await this.d.pauses.list(key, 100)).find((p) => p.id === parsed.data.id);
    if (!mine) throw new NotFoundException({ error: 'pause_not_found' });
    if (mine.resumedAt) throw new ConflictException({ error: 'not_paused', details: 'this series is already resumed' });
    await this.d.pauses.resume(mine.id, 'dashboard');
    return this.seriesPauses(handle);
  }

  async memory(handle: string) {
    const a = await this.require(handle);
    const orch = await this.orchestratorOf(a);
    const key = telegramKeyOf(orch);
    const memory = key ? await this.d.memory(key) : [];
    const rules = new Set(ownerRulesOf(memory).map((r) => r.id));
    const lint = this.d.ruleLint;
    // Spec 047 FR-004: the rules written before the lint get the same check, so junk is visible and can be retired.
    return {
      channelKey: key,
      memory: await Promise.all(memory.map(async (m) => (lint && rules.has(m.id)
        ? { ...m, lint: await lint(m.text, orch).catch(() => []) }
        : m))),
    };
  }

  // ── resource profile (spec 018) ───────────────────────────────────────────

  private profileKey(orch: Agent): string | null {
    if (!orch.scopeId) return null;
    return orch.scope === 'network' ? `network:${orch.scopeId}` : orch.scopeId;
  }

  async getProfile(handle: string) {
    const orch = await this.orchestratorOf(await this.require(handle));
    const key = this.profileKey(orch);
    const stored = key && this.d.profiles ? await this.d.profiles.get(key) : null;
    return { ref: key, profile: stored?.profile ?? null, health: stored?.health ?? null, updatedAt: stored?.updatedAt ?? null };
  }

  /** Spec 049 FR-002: the owner mutes the daily "connection broken" reminders of the agent's resource. */
  async dismissHealth(handle: string) {
    const orch = await this.orchestratorOf(await this.require(handle));
    const key = this.profileKey(orch);
    if (!key || !this.d.profiles) throw new BadRequestException({ error: 'no_resource', details: 'this agent has no resource' });
    const muted = await dismissHealth(this.d.profiles, key, new Date());
    if (!muted) throw new BadRequestException({ error: 'not_broken', details: 'the resource is not in a bad state' });
    return this.getProfile(handle);
  }

  async putProfile(handle: string, body: unknown) {
    const orch = await this.orchestratorOf(await this.require(handle));
    const key = this.profileKey(orch);
    if (!key) throw new BadRequestException({ error: 'no_resource', details: 'system agents have no resource profile' });
    await this.setProfile(key, body, 'owner');
    // Spec 041 FR-003: what the saved profile now contradicts, shown right away.
    return { ...(await this.getProfile(handle)), conflicts: (await this.configConflicts(handle)).conflicts };
  }

  async setProfile(ref: string, body: unknown, by: 'owner' | 'builder' | 'agent') {
    if (!this.d.profiles) throw new BadRequestException({ error: 'profiles_unavailable' });
    const p = ResourceProfileSchema.safeParse(body ?? {});
    if (!p.success) throw badRequest(p.error);
    await this.d.profiles.setProfile(ref, p.data, by);
    // Spec 040 FR-012: the profile's tone attaches the matching tone-* skill to the resource's agent.
    const net = ref.startsWith('network:') ? ref.slice('network:'.length) : null;
    const orch = await this.d.agents.findTop('orchestrator', net ? 'network' : 'resource', net ?? ref).catch(() => null);
    if (orch) await attachProfileTone({ skills: this.d.skills }, orch, p.data);
  }

  // ── per-resource formatting (spec 024 FR-013) ─────────────────────────────

  /** The resources whose formatting this agent's page shows: its network's members, else its own resource. */
  private async formatRefs(orch: Agent): Promise<Array<{ ref: string; platform: string; title: string | null }>> {
    const key = telegramKeyOf(orch);
    if (key) {
      const repo = new NetworkRepository(this.d.pool);
      const g = await repo.groupOfChannel(key);
      const members = g ? await repo.groupResources(g.id) : [];
      const anchor = `telegram:${key}`;
      return members.some((m) => m.ref === anchor) ? members : [{ ref: anchor, platform: 'telegram', title: null }, ...members];
    }
    const own = this.profileKey(orch);
    return own && !own.startsWith('network:') ? [{ ref: own, platform: own.slice(0, own.indexOf(':')), title: null }] : [];
  }

  async getFormatting(handle: string) {
    if (!this.d.profiles) throw new BadRequestException({ error: 'profiles_unavailable' });
    const orch = await this.orchestratorOf(await this.require(handle));
    const refs = await this.formatRefs(orch);
    const now = (this.d.now ?? (() => new Date()))();
    const resources: Array<Record<string, unknown>> = [];
    for (const r of refs) {
      const f = await this.d.profiles.formatOf(r.ref);
      resources.push({
        ref: r.ref, platform: r.platform, title: r.title, formatPrefs: f.prefs, locks: f.locks, updatedAt: f.updatedAt,
        changesToday: await this.d.profiles.formatChangesToday(r.ref, now),
        // Spec 034 FR-005: the effective poll / reader-question caps (defaults and the news topic included).
        // Spec 070: plus `defaultPollsPerWeek`, the cap an empty «Polls a week» field falls back to (the topic inference).
        audience: await this.d.profiles.audienceViewOf(r.ref),
        // Spec 037 FR-008: the style sheet as stored, with the owner's defaults, and (Telegram) the hashtag vocabulary.
        style: await resourceStyleOf(this.d.pool, r.ref),
      });
    }
    const agents = new Map((await this.d.agents.list()).map((a) => [a.id, a.handle]));
    const history = (await this.d.profiles.history(refs.map((r) => r.ref), 60))
      .filter((h) => h.kind === 'format' || Object.keys(h.diff).some((k) => k.startsWith('format_')))
      .map((h) => ({ ...h, agentHandle: h.agentId ? agents.get(h.agentId) ?? null : null }));
    return { changesPerDay: FORMAT_CHANGES_PER_DAY, resources, history };
  }

  /** The owner's edit: the whole format_prefs of one resource plus the locked fields. */
  async putFormatting(handle: string, ref: string, body: unknown) {
    if (!this.d.profiles) throw new BadRequestException({ error: 'profiles_unavailable' });
    const orch = await this.orchestratorOf(await this.require(handle));
    if (!(await this.formatRefs(orch)).some((r) => r.ref === ref)) throw new NotFoundException({ error: 'resource_not_found', details: ref });
    const p = z.object({ format_prefs: FormatPrefsSchema, format_locks: FormatLocksSchema.default([]), reason: z.string().trim().max(300).optional() }).strict().safeParse(body ?? {});
    if (!p.success) throw badRequest(p.error);
    const r = await this.d.profiles.patchFormat(ref, p.data.format_prefs as Record<string, unknown>, {
      by: 'owner', locks: p.data.format_locks, replace: true, reason: p.data.reason ?? 'owner edit',
    });
    if ('error' in r && r.error !== 'no_change') throw new BadRequestException(r);
    return { ...(await this.getFormatting(handle)), conflicts: (await this.configConflicts(handle)).conflicts };
  }

  private briefHook: ((agent: Agent, brief: string) => Promise<void>) | null = null;

  /** Spec 020 registers the playbook rebuild here. */
  setBriefHook(fn: (agent: Agent, brief: string) => Promise<void>): void {
    this.briefHook = fn;
  }

  async onBrief(agent: Agent, brief: string): Promise<void> {
    if (!this.briefHook) return;
    try { await this.briefHook(await this.orchestratorOf(agent), brief); } catch (err: any) { this.d.log?.(`brief hook failed: ${errText(err)}`); }
  }

  /** Mentionable agents for the chat's @ autocomplete. */
  async handles() {
    const all = await this.d.agents.list();
    return {
      agents: all.filter((a) => !a.parentId).map((a) => ({ handle: a.handle, name: a.name, emoji: a.emoji, kind: a.kind, scope: a.scope, scopeId: a.scopeId, mode: a.mode })),
    };
  }

  // ── confirmation cards (spec 018 FR-005) ──────────────────────────────────

  /** One confirmation card — a card made outside a chat (manager, data, migration) opens in a dialog from "Waiting for you". */
  async action(id: string) {
    const a = this.d.actions ? await this.d.actions.get(id) : null;
    if (!a) throw new NotFoundException({ error: 'action_not_found' });
    return { action: a };
  }

  async applyAction(id: string, input: unknown = null) {
    if (!this.d.actions) throw new NotFoundException({ error: 'actions_unavailable' });
    try {
      return { action: await this.d.actions.apply(id, input) };
    } catch (err: any) {
      if (err?.status === 404) throw new NotFoundException({ error: 'action_not_found' });
      if (err?.status === 409) throw new ConflictException({ error: err.message });
      if (err?.keepPending) throw new BadRequestException({ error: err.code ?? 'invalid_choice', details: err.message });
      throw err;
    }
  }

  async discardAction(id: string) {
    if (!this.d.actions) throw new NotFoundException({ error: 'actions_unavailable' });
    try {
      return { action: await this.d.actions.discard(id) };
    } catch (err: any) {
      if (err?.status === 404) throw new NotFoundException({ error: 'action_not_found' });
      throw err;
    }
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
