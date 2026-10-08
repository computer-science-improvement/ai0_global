import type { Pool, PoolClient } from 'pg';
import type { EditorRole } from '../llm/llm.types';
import { isOptionalSkill, isProtectedSkill, Skill, SkillLibrary, SkillView } from '../skills/skill-library';
import { lintSkill, SKILL_MAX_INLINE_BODY, SkillLintResult } from './skill-lint';

export type SkillScope = 'builtin' | 'global' | 'agent';
export type SkillAuthor = 'repo' | 'owner' | 'agent';
export type VersionOutcome = 'pending' | 'kept' | 'rolled_back' | 'superseded';

export interface SkillRow {
  id:             string;
  name:           string;
  scope:          SkillScope;
  agentId:        string | null;
  description:    string;
  appliesTo:      string[];
  body:           string;
  locked:         boolean;
  safety:         boolean;
  currentVersion: number;
  baseVersion:    number | null;
  createdBy:      SkillAuthor;
  updatedAt:      Date;
}

export interface SkillVersionRow {
  id:            number;
  skillId:       string;
  version:       number;
  body:          string;
  description:   string;
  appliesTo:     string[];
  author:        SkillAuthor;
  authorAgentId: string | null;
  reason:        string | null;
  kpiBaseline:   unknown;
  reviewAt:      Date | null;
  outcome:       VersionOutcome | null;
  outcomeDetail: unknown;
  createdAt:     Date;
}

/** One line of an agent's skills tab. */
export interface AgentSkillEntry {
  skill:       SkillRow;
  /** builtin / global as shipped, an agent override of a builtin, or the agent's own skill. */
  origin:      'builtin' | 'global' | 'override' | 'own' | 'inherited';
  enabled:     boolean;
  inline:      boolean;
  /** Override only: the builtin moved on since the fork. */
  baseChanged: boolean;
  /** The current version is an agent self-edit still under review. */
  pending:     boolean;
}

export interface WriteSkillInput {
  agentId:        string;
  name:           string;
  description:    string;
  appliesTo:      string[];
  body:           string;
  author:         'owner' | 'agent';
  authorAgentId?: string | null;
  reason?:        string | null;
  kpiBaseline?:   unknown;
  reviewAt?:      Date | null;
  /** Owner only: accept soft lint errors. */
  force?:         boolean;
}

export type WriteSkillResult =
  | { ok: true; skill: SkillRow; version: number; lint: SkillLintResult }
  | { error: string; details?: unknown };

const rowToSkill = (r: any): SkillRow => ({
  id: r.id, name: r.name, scope: r.scope, agentId: r.agent_id ?? null, description: r.description,
  appliesTo: r.applies_to ?? [], body: r.body, locked: !!r.locked, safety: !!r.safety,
  currentVersion: Number(r.current_version), baseVersion: r.base_version == null ? null : Number(r.base_version),
  createdBy: r.created_by, updatedAt: r.updated_at,
});

const rowToVersion = (r: any): SkillVersionRow => ({
  id: Number(r.id), skillId: r.skill_id, version: Number(r.version), body: r.body, description: r.description,
  appliesTo: r.applies_to ?? [], author: r.author, authorAgentId: r.author_agent_id ?? null, reason: r.reason ?? null,
  kpiBaseline: r.kpi_baseline ?? null, reviewAt: r.review_at ?? null, outcome: r.outcome ?? null,
  outcomeDetail: r.outcome_detail ?? null, createdAt: r.created_at,
});

const toSkill = (r: SkillRow): Skill => ({
  name: r.name, description: r.description, appliesTo: r.appliesTo as EditorRole[], body: r.body, ...(r.safety ? { safety: true } : {}),
});

type Pg = Pick<Pool, 'query' | 'connect'>;

/**
 * Skills in the DB (spec 017 FR-004–FR-006): builtin rows mirror the repo files,
 * agents get overrides and their own skills, every write is a version.
 */
export class SkillStore {
  constructor(private readonly pool: Pg) {}

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  /** Upsert every repo skill as a builtin; a changed file becomes a new 'repo' version. */
  async syncBuiltins(lib: Pick<SkillLibrary, 'all'>): Promise<{ inserted: number; updated: number }> {
    let inserted = 0;
    let updated = 0;
    for (const s of lib.all()) {
      await this.tx(async (c) => {
        const { rows } = await c.query(`SELECT * FROM skills WHERE scope = 'builtin' AND name = $1 FOR UPDATE`, [s.name]);
        if (!rows[0]) {
          const ins = await c.query(
            `INSERT INTO skills (name, scope, description, applies_to, body, safety, created_by) VALUES ($1, 'builtin', $2, $3, $4, $5, 'repo') RETURNING id`,
            [s.name, s.description, s.appliesTo, s.body, !!s.safety]);
          await c.query(
            `INSERT INTO skill_versions (skill_id, version, body, description, applies_to, author) VALUES ($1, 1, $2, $3, $4, 'repo')`,
            [ins.rows[0].id, s.body, s.description, s.appliesTo]);
          inserted++;
          return;
        }
        const cur = rowToSkill(rows[0]);
        const same = cur.body === s.body && cur.description === s.description
          && cur.appliesTo.join(',') === s.appliesTo.join(',') && cur.safety === !!s.safety;
        if (same) return;
        const v = cur.currentVersion + 1;
        await c.query(
          `UPDATE skills SET body = $2, description = $3, applies_to = $4, safety = $5, current_version = $6, updated_at = now() WHERE id = $1`,
          [cur.id, s.body, s.description, s.appliesTo, !!s.safety, v]);
        await c.query(
          `INSERT INTO skill_versions (skill_id, version, body, description, applies_to, author, reason) VALUES ($1, $2, $3, $4, $5, 'repo', 'repo update')`,
          [cur.id, v, s.body, s.description, s.appliesTo]);
        updated++;
      });
    }
    return { inserted, updated };
  }

  async get(id: string): Promise<SkillRow | null> {
    const { rows } = await this.pool.query(`SELECT * FROM skills WHERE id = $1`, [id]);
    return rows[0] ? rowToSkill(rows[0]) : null;
  }

  async findForAgent(agentId: string, name: string): Promise<SkillRow | null> {
    const { rows } = await this.pool.query(`SELECT * FROM skills WHERE agent_id = $1 AND name = $2`, [agentId, name]);
    return rows[0] ? rowToSkill(rows[0]) : null;
  }

  async findShared(name: string): Promise<SkillRow | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM skills WHERE agent_id IS NULL AND name = $1 ORDER BY (scope = 'builtin') DESC LIMIT 1`, [name]);
    return rows[0] ? rowToSkill(rows[0]) : null;
  }

  /**
   * Every skill an agent sees, with toggles. `chain` is [agent, parent?]: a role
   * child inherits its orchestrator's own skills and toggles; its own win.
   */
  async listForAgent(chain: string[]): Promise<AgentSkillEntry[]> {
    const [self] = chain;
    const { rows: shared } = await this.pool.query(`SELECT * FROM skills WHERE agent_id IS NULL ORDER BY name`);
    const { rows: own } = await this.pool.query(`SELECT * FROM skills WHERE agent_id = ANY($1::uuid[]) ORDER BY name`, [chain]);
    const { rows: toggles } = await this.pool.query(`SELECT * FROM agent_skills WHERE agent_id = ANY($1::uuid[])`, [chain]);
    const { rows: pend } = await this.pool.query(
      `SELECT DISTINCT ON (skill_id) skill_id, outcome FROM skill_versions
        WHERE skill_id = ANY($1::uuid[]) ORDER BY skill_id, version DESC`, [own.map((r) => r.id)]);
    const pendingSet = new Set(pend.filter((r) => r.outcome === 'pending').map((r) => r.skill_id));

    const rank = (agentId: string) => { const i = chain.indexOf(agentId); return i < 0 ? 99 : i; };
    const toggleOf = (skillId: string) => toggles
      .filter((t) => t.skill_id === skillId)
      .sort((a, b) => rank(a.agent_id) - rank(b.agent_id))[0];

    const ownByName = new Map<string, SkillRow>();
    for (const r of own.map(rowToSkill).sort((a, b) => rank(b.agentId!) - rank(a.agentId!))) ownByName.set(r.name, r);
    const sharedRows = shared.map(rowToSkill);
    const builtinVersion = new Map(sharedRows.filter((s) => s.scope === 'builtin').map((s) => [s.name, s.currentVersion]));

    const out: AgentSkillEntry[] = [];
    for (const s of sharedRows) {
      if (ownByName.has(s.name)) continue;
      const t = toggleOf(s.id);
      // Spec 034 FR-014: a builtin tone skill is off until attached to this agent's resource.
      const byDefault = !(s.scope === 'builtin' && isOptionalSkill(s.name));
      out.push({ skill: s, origin: s.scope === 'builtin' ? 'builtin' : 'global', enabled: t ? !!t.enabled : byDefault, inline: t ? !!t.inline : false, baseChanged: false, pending: false });
    }
    for (const s of ownByName.values()) {
      const t = toggleOf(s.id);
      const isOverride = builtinVersion.has(s.name);
      out.push({
        skill: s,
        origin: s.agentId !== self ? 'inherited' : isOverride ? 'override' : 'own',
        enabled: t ? !!t.enabled : true,
        inline: t ? !!t.inline : false,
        baseChanged: isOverride && s.baseVersion != null && (builtinVersion.get(s.name) ?? 0) > s.baseVersion,
        pending: pendingSet.has(s.id),
      });
    }
    return out.sort((a, b) => a.skill.name.localeCompare(b.skill.name));
  }

  /** The effective skill set of an agent for one role (FR-006). */
  async resolveForAgent(chain: string[], role: EditorRole): Promise<SkillView> {
    const entries = await this.listForAgent(chain);
    const live = entries.filter((e) => e.enabled && e.skill.appliesTo.includes(role));
    const inline = live.filter((e) => e.inline && e.skill.body.length <= SKILL_MAX_INLINE_BODY).map((e) => e.skill.name);
    return new SkillView(live.map((e) => toSkill(e.skill)), inline);
  }

  async setToggle(agentId: string, skillId: string, p: { enabled?: boolean; inline?: boolean }): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_skills (agent_id, skill_id, enabled, inline) VALUES ($1, $2, COALESCE($3, true), COALESCE($4, false))
       ON CONFLICT (agent_id, skill_id) DO UPDATE
         SET enabled = COALESCE($3, agent_skills.enabled), inline = COALESCE($4, agent_skills.inline)`,
      [agentId, skillId, p.enabled ?? null, p.inline ?? null]);
  }

  /**
   * Attach a shared skill to an agent: enabled and always in context (spec 034 FR-014, a resource tone skill on
   * strategy migration). An explicit "off" the owner set earlier wins: it is not switched back on.
   */
  async attachShared(agentId: string, name: string): Promise<'attached' | 'kept_off' | 'missing'> {
    const s = await this.findShared(name);
    if (!s) return 'missing';
    const { rows } = await this.pool.query(`SELECT enabled FROM agent_skills WHERE agent_id = $1 AND skill_id = $2`, [agentId, s.id]);
    if (rows[0] && rows[0].enabled === false) return 'kept_off';
    await this.setToggle(agentId, s.id, { enabled: true, inline: s.body.length <= SKILL_MAX_INLINE_BODY });
    return 'attached';
  }

  async setLocked(skillId: string, locked: boolean): Promise<void> {
    await this.pool.query(`UPDATE skills SET locked = $2, updated_at = now() WHERE id = $1`, [skillId, locked]);
  }

  /**
   * Create or update an agent-scope skill (own or an override of a shared one).
   * Agents may not touch safety, locked or owner-authored skills (FR-008); owner
   * writes supersede pending agent versions.
   */
  async writeAgentSkill(i: WriteSkillInput): Promise<WriteSkillResult> {
    const lint = lintSkill({ name: i.name, description: i.description, appliesTo: i.appliesTo, body: i.body });
    if (!lint.ok) {
      const forceable = i.author === 'owner' && i.force && lint.errors.every((e) => !e.hard && !['name', 'description', 'applies_to', 'body_empty', 'body_too_long'].includes(e.code));
      if (!forceable) return { error: 'skill_lint_failed', details: lint.errors };
    }
    const shared = await this.findShared(i.name);
    const existing = await this.findForAgent(i.agentId, i.name);

    if (i.author === 'agent') {
      if (shared?.safety || existing?.safety || isProtectedSkill(i.name)) return { error: 'safety_skill', details: 'системні скіли безпеки й голосу агент змінювати не може' };
      if (existing?.locked || shared?.locked) return { error: 'skill_locked', details: 'власник заблокував цей скіл' };
      if (existing) {
        const { rows } = await this.pool.query(
          `SELECT author FROM skill_versions WHERE skill_id = $1 AND version = $2`, [existing.id, existing.currentVersion]);
        if (rows[0]?.author === 'owner') return { error: 'owner_authored', details: 'поточну версію написав власник — агент її не змінює' };
      }
    }

    return this.tx(async (c) => {
      let skillId: string;
      let version: number;
      if (!existing) {
        const ins = await c.query(
          `INSERT INTO skills (name, scope, agent_id, description, applies_to, body, safety, base_version, created_by)
           VALUES ($1, 'agent', $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [i.name, i.agentId, i.description, i.appliesTo, i.body, !!shared?.safety || isProtectedSkill(i.name), shared?.scope === 'builtin' ? shared.currentVersion : null, i.author]);
        skillId = ins.rows[0].id;
        version = 1;
      } else {
        skillId = existing.id;
        version = existing.currentVersion + 1;
        await c.query(
          `UPDATE skills SET description = $2, applies_to = $3, body = $4, current_version = $5, updated_at = now() WHERE id = $1`,
          [skillId, i.description, i.appliesTo, i.body, version]);
        await c.query(
          `UPDATE skill_versions SET outcome = 'superseded' WHERE skill_id = $1 AND outcome = 'pending'`, [skillId]);
      }
      await c.query(
        `INSERT INTO skill_versions (skill_id, version, body, description, applies_to, author, author_agent_id, reason, kpi_baseline, review_at, outcome)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [skillId, version, i.body, i.description, i.appliesTo, i.author, i.authorAgentId ?? null, i.reason ?? null,
          i.kpiBaseline == null ? null : JSON.stringify(i.kpiBaseline), i.reviewAt ?? null, i.author === 'agent' ? 'pending' : null]);
      const { rows } = await c.query(`SELECT * FROM skills WHERE id = $1`, [skillId]);
      return { ok: true as const, skill: rowToSkill(rows[0]), version, lint };
    });
  }

  /** Remove an agent's override or own skill ("reset to default" / delete). */
  async deleteAgentSkill(agentId: string, name: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM skills WHERE agent_id = $1 AND name = $2`, [agentId, name]);
    return (rowCount ?? 0) > 0;
  }

  async versions(skillId: string): Promise<SkillVersionRow[]> {
    const { rows } = await this.pool.query(`SELECT * FROM skill_versions WHERE skill_id = $1 ORDER BY version DESC`, [skillId]);
    return rows.map(rowToVersion);
  }

  /** Restore an older version's text as a new version (history is never rewritten). */
  async rollback(skillId: string, toVersion: number, author: 'owner' | 'agent', reason: string): Promise<WriteSkillResult> {
    const skill = await this.get(skillId);
    if (!skill) return { error: 'skill_not_found' };
    if (skill.scope === 'builtin') return { error: 'builtin_readonly', details: 'a built-in skill changes only in the repository; roll back the agent override instead' };
    const { rows } = await this.pool.query(`SELECT * FROM skill_versions WHERE skill_id = $1 AND version = $2`, [skillId, toVersion]);
    if (!rows[0]) return { error: 'version_not_found' };
    const v = rowToVersion(rows[0]);
    return this.tx(async (c) => {
      const next = skill.currentVersion + 1;
      await c.query(
        `UPDATE skills SET body = $2, description = $3, applies_to = $4, current_version = $5, updated_at = now() WHERE id = $1`,
        [skillId, v.body, v.description, v.appliesTo, next]);
      await c.query(`UPDATE skill_versions SET outcome = 'superseded' WHERE skill_id = $1 AND outcome = 'pending'`, [skillId]);
      await c.query(
        `INSERT INTO skill_versions (skill_id, version, body, description, applies_to, author, reason) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [skillId, next, v.body, v.description, v.appliesTo, author === 'agent' ? 'agent' : 'owner', reason]);
      const { rows: s } = await c.query(`SELECT * FROM skills WHERE id = $1`, [skillId]);
      return { ok: true as const, skill: rowToSkill(s[0]), version: next, lint: { ok: true, errors: [], warnings: [] } };
    });
  }

  /** Self-edits under review whose review date has come. */
  async duePending(now: Date): Promise<Array<SkillVersionRow & { agentId: string; currentVersion: number }>> {
    const { rows } = await this.pool.query(
      `SELECT v.*, s.agent_id AS skill_agent_id, s.current_version AS skill_current_version
         FROM skill_versions v JOIN skills s ON s.id = v.skill_id
        WHERE v.outcome = 'pending' AND v.review_at <= $1 ORDER BY v.review_at`, [now]);
    return rows.map((r) => ({ ...rowToVersion(r), agentId: r.skill_agent_id, currentVersion: Number(r.skill_current_version) }));
  }

  async setOutcome(versionId: number, outcome: VersionOutcome, detail: unknown, reviewAt?: Date | null): Promise<void> {
    await this.pool.query(
      `UPDATE skill_versions SET outcome = $2, outcome_detail = $3, review_at = COALESCE($4, review_at) WHERE id = $1`,
      [versionId, outcome, detail == null ? null : JSON.stringify(detail), reviewAt ?? null]);
  }

  /** Agent self-edits made today (Kyiv day) by this agent — rate limit (FR-008). */
  async selfEditsToday(agentId: string): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM skill_versions
        WHERE author = 'agent' AND author_agent_id = $1
          AND (created_at AT TIME ZONE 'Europe/Kyiv')::date = (now() AT TIME ZONE 'Europe/Kyiv')::date`, [agentId]);
    return Number(rows[0]?.n ?? 0);
  }
}
