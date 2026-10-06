import type { Agent } from './agent.types';
import type { AgentsRepository } from './agents.repository';
import type { OwnerInbox } from './owner-inbox';
import { judgeKpiChange, KpiPoint, ScopeKpi } from './scope-kpi';
import type { SkillStore } from './skill-store';

export const REVIEW_POSTPONE_DAYS = 7;
export const MAX_POSTPONES = 2;

export interface SkillEvaluatorDeps {
  skills:  Pick<SkillStore, 'duePending' | 'setOutcome' | 'rollback' | 'deleteAgentSkill' | 'get'>;
  agents:  Pick<AgentsRepository, 'get'>;
  kpi:     ScopeKpi;
  inbox:   Pick<OwnerInbox, 'post'>;
  /** Writes an 'avoid' memory entry for the agent's channel (when it has one). */
  remember?: (agent: Agent, text: string, evidence: unknown) => Promise<void>;
  log?:    (msg: string) => void;
}

/**
 * Daily check of agent skill self-edits (spec 017 FR-009): keep the change, or
 * roll it back when the scope's KPI dropped beyond the noise band. Missing data
 * postpones the review (at most twice), then the version is kept with a note.
 */
export class SkillVersionEvaluator {
  constructor(private readonly d: SkillEvaluatorDeps) {}

  async run(now = new Date()): Promise<{ kept: number; rolledBack: number; postponed: number }> {
    let kept = 0;
    let rolledBack = 0;
    let postponed = 0;
    for (const v of await this.d.skills.duePending(now)) {
      try {
        const owner = v.agentId ? await this.d.agents.get(v.agentId) : null;
        const author = v.authorAgentId ? await this.d.agents.get(v.authorAgentId) : owner;
        const scopeAgent = owner ?? author;
        if (!scopeAgent) { await this.d.skills.setOutcome(v.id, 'kept', { note: 'agent deleted' }); kept++; continue; }

        const before = (v.kpiBaseline ?? null) as KpiPoint | null;
        const after = await this.d.kpi.primary(scopeAgent, now);
        const verdict = judgeKpiChange(before, after);
        const skill = await this.d.skills.get(v.skillId);
        const name = skill?.name ?? v.skillId;

        if (verdict.verdict === 'insufficient') {
          const n = Number((v.outcomeDetail as any)?.postponed ?? 0);
          if (n < MAX_POSTPONES) {
            await this.d.skills.setOutcome(v.id, 'pending', { postponed: n + 1, after }, new Date(now.getTime() + REVIEW_POSTPONE_DAYS * 86_400_000));
            postponed++;
          } else {
            await this.d.skills.setOutcome(v.id, 'kept', { note: 'not enough data to judge', after });
            kept++;
          }
          continue;
        }

        if (verdict.verdict === 'kept') {
          await this.d.skills.setOutcome(v.id, 'kept', { ...verdict, before, after });
          kept++;
          continue;
        }

        // Roll back: restore the previous version, or remove a skill the agent created from scratch.
        if (v.version > 1) {
          const r = await this.d.skills.rollback(v.skillId, v.version - 1, 'agent', `auto-rollback: KPI ${verdict.deltaPct.toFixed(0)}% (z ${verdict.z.toFixed(1)})`);
          if ('error' in r) { this.d.log?.(`skill rollback ${name} failed: ${r.error}`); continue; }
        } else if (skill?.agentId) {
          await this.d.skills.deleteAgentSkill(skill.agentId, skill.name);
        }
        await this.d.skills.setOutcome(v.id, 'rolled_back', { ...verdict, before, after });
        rolledBack++;
        const text = `Самоправку скіла «${name}» відкочено: перегляди на пост ${verdict.deltaPct.toFixed(0)}% (z ${verdict.z.toFixed(1)}) за 7 днів після зміни.`;
        await this.d.inbox.post({
          agentId: scopeAgent.id, kind: 'skill_rolled_back', severity: 'info',
          title: `↩️ @${scopeAgent.handle}: skill "${name}" rolled back`,
          body: `Self-edit of skill "${name}" rolled back: views per post ${verdict.deltaPct.toFixed(0)}% (z ${verdict.z.toFixed(1)}) over the 7 days after the change.\nReason for the change: ${v.reason ?? '—'}`,
          alert: { title: `↩️ @${scopeAgent.handle}: скіл «${name}» відкочено`, body: `${text}\nПричина зміни була: ${v.reason ?? '—'}` },
          refType: 'skill', refId: v.skillId,
        });
        if (this.d.remember) {
          try { await this.d.remember(scopeAgent, `Не повторювати зміну скіла «${name}»: ${v.reason ?? ''} — після неї ${text}`.slice(0, 400), { skill: name, ...verdict }); }
          catch { /* memory note is best-effort */ }
        }
      } catch (err: any) {
        this.d.log?.(`skill evaluation of version ${v.id} failed: ${err?.message ?? err}`);
      }
    }
    return { kept, rolledBack, postponed };
  }
}
