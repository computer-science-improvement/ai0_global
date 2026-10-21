import type { Pool } from 'pg';
import { telegramKeyOf, type Agent } from '../agents/agent.types';
import type { AgentsRepository } from '../agents/agents.repository';
import type { SkillStore } from '../agents/skill-store';
import {
  AUDIT_LIMITS, type AgentConflictsFact, type AgentFact, type AuditFacts, type MemoryFact, type PlaybookFact, type ProbeFacts, type RollbackFact, type RoleRunFact,
  type RuleFact, type SkillFact, type SteeringFact, type ToolStatFact,
} from './audit.types';

type Q = Pick<Pool, 'query'>;

/** What the loader needs from the rest of the system; each port is a read of an existing service. */
export interface AuditQueriesDeps {
  pool:   Q;
  agents: Pick<AgentsRepository, 'list'>;
  skills: Pick<SkillStore, 'listForAgent'>;
  /** The tool names that exist (the ToolRegistry). */
  tools:  () => ReadonlySet<string>;
  /** Spec 047 FR-004: the owner-rule lint for a rule of the channel's orchestrator (no orchestrator → the lint without context). */
  ruleLint: (text: string, orch: Agent | null) => Promise<Array<{ code: string; detail: string }>>;
  /** Spec 040 FR-011: where an orchestrator's playbook and profiles contradict the owner's rules. */
  conflicts: (orch: Agent) => Promise<Array<{ code: string; ref: string; detail: string; rule_id?: number | null }>>;
  /** The active playbook of an orchestrator with its validation (errors) and soft warnings; null = no active playbook. */
  playbook: (orch: Agent) => Promise<{ version: number; errors: string[]; warnings: Array<{ code: string; ref: string; uk?: string; en?: string }> } | null>;
  now?: () => Date;
}

const DAY_MS = 86_400_000;

/**
 * Spec 055 FR-001: loads the facts the checks read. Reads only; every number comes from the tables the agents already
 * write (runs, steps, skills, memory, steering), the rest from the services that own the rule (lint, conflicts, playbook).
 * A failing source leaves that part of the facts empty — one broken table never stops the audit.
 */
export class AuditQueries {
  constructor(private readonly d: AuditQueriesDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  async load(): Promise<AuditFacts> {
    const now = this.now();
    const all = await this.d.agents.list();
    const top = all.filter((a) => !a.parentId);
    const [skills, agents, rollbacks, probes, memory, steering, toolStats, roleRuns] = await Promise.all([
      this.skillRows().catch(() => []),
      this.agentFacts(top, all, now).catch(() => []),
      this.rollbacks(now).catch(() => []),
      this.probes(now).catch((): ProbeFacts => ({ stuck: [], rejects: [] })),
      this.memory().catch(() => []),
      this.steering().catch(() => []),
      this.toolStats(now).catch(() => []),
      this.roleRuns(now).catch(() => []),
    ]);
    const orchByChannel = new Map<string, Agent>();
    for (const a of top) {
      const key = a.kind === 'orchestrator' ? telegramKeyOf(a) : null;
      if (key) orchByChannel.set(key, a);
    }
    const [rules, conflicts, playbooks] = await Promise.all([
      this.rules(memory, orchByChannel).catch(() => []),
      this.conflictFacts(top).catch(() => []),
      this.playbookFacts(top).catch(() => []),
    ]);
    return { now, knownTools: this.d.tools(), skills, agents, rollbacks, probes, memory, rules, conflicts, playbooks, steering, toolStats, roleRuns };
  }

  // ── skills ────────────────────────────────────────────────────────────────

  async skillRows(): Promise<SkillFact[]> {
    const { rows } = await this.d.pool.query(
      `SELECT s.id, s.name, s.scope, s.description, s.applies_to, s.body, s.safety, s.locked, a.handle AS agent
         FROM skills s LEFT JOIN agents a ON a.id = s.agent_id ORDER BY s.name, a.handle NULLS FIRST`);
    return rows.map((r) => ({
      id: r.id, name: r.name, scope: r.scope, agent: r.agent ?? null, description: r.description, appliesTo: r.applies_to ?? [],
      body: r.body, safety: !!r.safety, locked: !!r.locked,
    }));
  }

  /** Top-level agents with their skills and, folded in from their role children, the runs and `load_skill` calls of the window. */
  async agentFacts(top: Agent[], all: Agent[], now: Date): Promise<AgentFact[]> {
    const topOf = new Map<string, string>();
    for (const a of all) topOf.set(a.id, a.parentId ?? a.id);
    const since = new Date(now.getTime() - AUDIT_LIMITS.unusedDays * DAY_MS);
    const { rows: runs } = await this.d.pool.query(
      `SELECT agent_id, role, count(*)::int AS n FROM editor_runs WHERE agent_id IS NOT NULL AND started_at > $1 GROUP BY agent_id, role`, [since]);
    const { rows: loads } = await this.d.pool.query(
      `SELECT r.agent_id, s.input->>'name' AS name, count(*)::int AS n
         FROM editor_run_steps s JOIN editor_runs r ON r.id = s.run_id
        WHERE s.tool_name = 'load_skill' AND NOT s.is_error AND s.created_at > $1 AND r.agent_id IS NOT NULL AND s.input->>'name' IS NOT NULL
        GROUP BY r.agent_id, s.input->>'name'`, [since]);
    const out: AgentFact[] = [];
    for (const a of top) {
      const mine = (id: string) => topOf.get(id) === a.id;
      const ownRuns = runs.filter((r) => mine(r.agent_id));
      const loadMap: Record<string, number> = {};
      for (const l of loads.filter((x) => mine(x.agent_id))) loadMap[l.name] = (loadMap[l.name] ?? 0) + l.n;
      const entries = await this.d.skills.listForAgent([a.id]).catch(() => []);
      out.push({
        id: a.id, handle: a.handle, kind: a.kind,
        runs: ownRuns.reduce((n, r) => n + r.n, 0),
        roles: [...new Set(ownRuns.map((r) => r.role as string))],
        loads: loadMap,
        skills: entries.map((e) => ({
          skillId: e.skill.id, name: e.skill.name, origin: e.origin, enabled: e.enabled, inline: e.inline, description: e.skill.description,
          appliesTo: e.skill.appliesTo, body: e.skill.body, safety: e.skill.safety, updatedAt: e.skill.updatedAt,
        })),
      });
    }
    return out;
  }

  /** Skills whose edits were rolled back, per skill, in the window. */
  async rollbacks(now: Date): Promise<RollbackFact[]> {
    const since = new Date(now.getTime() - AUDIT_LIMITS.rollbackDays * DAY_MS);
    const { rows } = await this.d.pool.query(
      `SELECT sv.skill_id, s.name, a.handle AS agent, count(*)::int AS n
         FROM skill_versions sv JOIN skills s ON s.id = sv.skill_id LEFT JOIN agents a ON a.id = s.agent_id
        WHERE sv.outcome = 'rolled_back' AND sv.created_at > $1 GROUP BY sv.skill_id, s.name, a.handle`, [since]);
    return rows.map((r) => ({ skillId: r.skill_id, name: r.name, agent: r.agent ?? null, count: r.n }));
  }

  /** Spec 059: edits waiting for their probe for too long, and the probe's rejections per agent in the window. */
  async probes(now: Date): Promise<ProbeFacts> {
    const stuckBefore = new Date(now.getTime() - AUDIT_LIMITS.probeStuckDays * DAY_MS);
    const since = new Date(now.getTime() - AUDIT_LIMITS.probeRejectDays * DAY_MS);
    const [stuck, rejects] = await Promise.all([
      this.d.pool.query(
        `SELECT sv.skill_id, s.name, a.handle AS agent, sv.version, sv.created_at
           FROM skill_versions sv JOIN skills s ON s.id = sv.skill_id LEFT JOIN agents a ON a.id = s.agent_id
          WHERE sv.outcome = 'probing' AND sv.created_at < $1 ORDER BY sv.created_at`, [stuckBefore]),
      this.d.pool.query(
        `SELECT a.handle AS agent, count(*)::int AS n, array_agg(DISTINCT s.name ORDER BY s.name) AS skills
           FROM skill_versions sv JOIN skills s ON s.id = sv.skill_id JOIN agents a ON a.id = s.agent_id
          WHERE sv.outcome = 'rejected' AND sv.created_at > $1 GROUP BY a.handle ORDER BY n DESC, a.handle`, [since]),
    ]);
    return {
      stuck: stuck.rows.map((r) => ({ skillId: r.skill_id, name: r.name, agent: r.agent ?? null, version: Number(r.version), since: r.created_at })),
      rejects: rejects.rows.map((r) => ({ agent: r.agent, count: r.n, skills: r.skills ?? [] })),
    };
  }

  // ── memory and rules ──────────────────────────────────────────────────────

  async memory(): Promise<MemoryFact[]> {
    const { rows } = await this.d.pool.query(
      `SELECT id, channel_key, kind, text, created_by, created_at, evidence->>'source' AS source
         FROM editor_channel_memory WHERE active ORDER BY channel_key, created_at DESC, id DESC`);
    return rows.map((r) => ({
      id: Number(r.id), channel: r.channel_key, kind: r.kind, text: r.text, createdBy: r.created_by, createdAt: r.created_at, source: r.source ?? null,
    }));
  }

  /** The owner's rules (not the preferences learnt on approval) with what the lint says about each. */
  async rules(memory: MemoryFact[], orchByChannel: Map<string, Agent>): Promise<RuleFact[]> {
    const out: RuleFact[] = [];
    for (const m of memory) {
      if (m.createdBy !== 'owner' || m.source === 'approval') continue;
      const orch = orchByChannel.get(m.channel) ?? null;
      const issues = await this.d.ruleLint(m.text, orch).catch(() => []);
      out.push({ id: m.id, channel: m.channel, agent: orch?.handle ?? null, text: m.text, issues });
    }
    return out;
  }

  async conflictFacts(top: Agent[]): Promise<AgentConflictsFact[]> {
    const out: AgentConflictsFact[] = [];
    for (const a of top) {
      if (a.kind !== 'orchestrator') continue;
      const list = await this.d.conflicts(a).catch(() => []);
      out.push({ agent: a.handle, channel: telegramKeyOf(a), conflicts: list.map((c) => ({ code: c.code, ref: c.ref, detail: c.detail, ruleId: c.rule_id ?? null })) });
    }
    return out;
  }

  async playbookFacts(top: Agent[]): Promise<PlaybookFact[]> {
    const out: PlaybookFact[] = [];
    for (const a of top) {
      if (a.kind !== 'orchestrator') continue;
      const p = await this.d.playbook(a).catch(() => null);
      if (!p) continue;
      out.push({
        agent: a.handle, channel: telegramKeyOf(a), version: p.version, errors: p.errors,
        warnings: p.warnings.map((w) => ({ code: w.code, ref: w.ref, text: w.en ?? w.uk ?? w.code })),
      });
    }
    return out;
  }

  /** Active steering sets with their usable rules and whether the target channel still has a card. */
  async steering(): Promise<SteeringFact[]> {
    const { rows } = await this.d.pool.query(
      `SELECT id, target_ref, channel_key, source_ref, status, rules FROM steering_sets WHERE status = 'active'`);
    const { rows: cards } = await this.d.pool.query(`SELECT channel_key FROM editor_channels`);
    const have = new Set(cards.map((c) => String(c.channel_key).toLowerCase()));
    return rows.map((r) => {
      const channel: string | null = r.channel_key ?? (String(r.target_ref).startsWith('telegram:') ? String(r.target_ref).slice('telegram:'.length) : null);
      const rules = Array.isArray(r.rules) ? r.rules : [];
      return {
        id: r.id, target: r.target_ref, channel, source: r.source_ref, status: r.status,
        enabledRules: rules.filter((x: { enabled?: boolean; conflict?: unknown }) => x.enabled !== false && !x.conflict).length,
        // A target that is not a Telegram channel has no card to look up.
        channelExists: channel ? have.has(channel.toLowerCase()) : true,
      };
    });
  }

  // ── tools ─────────────────────────────────────────────────────────────────

  async toolStats(now: Date): Promise<ToolStatFact[]> {
    const since = new Date(now.getTime() - AUDIT_LIMITS.toolWindowDays * DAY_MS);
    const { rows } = await this.d.pool.query(
      `SELECT tool_name, count(*)::int AS calls, (count(*) FILTER (WHERE is_error))::int AS errors
         FROM editor_run_steps WHERE type = 'tool' AND tool_name IS NOT NULL AND created_at > $1 GROUP BY tool_name`, [since]);
    const failing = rows.filter((r) => r.errors > 0).map((r) => r.tool_name as string);
    const texts = new Map<string, Array<{ text: string; count: number }>>();
    if (failing.length) {
      const { rows: errs } = await this.d.pool.query(
        `SELECT tool_name, left(COALESCE(output->>'error', output::text, ''), 300) AS text, count(*)::int AS n
           FROM editor_run_steps WHERE type = 'tool' AND is_error AND created_at > $1 AND tool_name = ANY($2::text[])
          GROUP BY tool_name, left(COALESCE(output->>'error', output::text, ''), 300) ORDER BY n DESC`, [since, failing]);
      for (const e of errs) texts.set(e.tool_name, [...(texts.get(e.tool_name) ?? []), { text: e.text, count: e.n }]);
    }
    return rows.map((r) => ({ tool: r.tool_name, calls: r.calls, errors: r.errors, topErrors: (texts.get(r.tool_name) ?? []).slice(0, 3) }));
  }

  async roleRuns(now: Date): Promise<RoleRunFact[]> {
    const since = new Date(now.getTime() - AUDIT_LIMITS.toolWindowDays * DAY_MS);
    const { rows } = await this.d.pool.query(
      `SELECT role, count(*)::int AS runs, (count(*) FILTER (WHERE status IN ('no_terminal','max_steps')))::int AS bad
         FROM editor_runs WHERE started_at > $1 AND status <> 'running' GROUP BY role`, [since]);
    return rows.map((r) => ({ role: r.role, runs: r.runs, bad: r.bad }));
  }
}
