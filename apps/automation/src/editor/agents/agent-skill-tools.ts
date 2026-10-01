import { z } from 'zod';
import { defineTool, EditorTool, ToolContext } from '../harness/tool';
import type { Agent } from './agent.types';
import type { AgentsRepository } from './agents.repository';
import type { OwnerInbox } from './owner-inbox';
import type { ScopeKpi } from './scope-kpi';
import type { SkillStore } from './skill-store';
import { SKILL_ROLES } from './skill-lint';

export const SELF_EDITS_PER_DAY = 1;
export const SELF_EDIT_REVIEW_DAYS = 7;

export interface AgentSkillToolDeps {
  agents: Pick<AgentsRepository, 'getByHandle' | 'get' | 'children'>;
  skills: Pick<SkillStore, 'writeAgentSkill' | 'selfEditsToday' | 'findForAgent' | 'findShared'>;
  kpi:    ScopeKpi;
  inbox:  Pick<OwnerInbox, 'post'>;
  now?:   () => Date;
}

function agentOf(ctx: ToolContext): Agent | null {
  return (ctx.extras?.agent as Agent | null | undefined) ?? null;
}

/** The orchestrator whose skills a run shares: itself, or the parent of a role child. */
async function scopeOwner(d: AgentSkillToolDeps, self: Agent): Promise<Agent> {
  if (!self.parentId) return self;
  return (await d.agents.get(self.parentId)) ?? self;
}

const diffLines = (a: string, b: string): string => {
  const A = new Set(a.split('\n'));
  const B = new Set(b.split('\n'));
  const removed = a.split('\n').filter((l) => l.trim() && !B.has(l)).slice(0, 12).map((l) => `- ${l}`);
  const added = b.split('\n').filter((l) => l.trim() && !A.has(l)).slice(0, 12).map((l) => `+ ${l}`);
  return [...removed, ...added].join('\n') || '(лише форматування)';
};

/**
 * propose_skill_edit (spec 017 FR-008): an orchestrator, reviewer or the manager
 * improves a skill of its own scope. The change applies at once as a new
 * version under review; the owner is told with the diff; the daily evaluator
 * rolls it back when the scope's KPI drops.
 */
export function buildAgentSkillTools(d: AgentSkillToolDeps): EditorTool[] {
  const now = d.now ?? (() => new Date());

  const proposeSkillEdit = defineTool({
    name: 'propose_skill_edit',
    description: [
      'Покращити скіл свого агента (або створити новий): нова версія застосовується одразу, власник отримує diff.',
      'Через 7 днів код порівнює KPI: якщо впали — зміна відкочується автоматично. Не частіше 1 разу на добу.',
      'Не можна: скіли безпеки, заблоковані власником, і ті, що власник написав сам. Пиши конкретні правила з причиною в reason.',
    ].join(' '),
    kind: 'act', roles: ['orchestrator', 'reviewer', 'manager'],
    input: z.object({
      skill:       z.string().min(3).max(48).describe('Назва скіла (існуючого — щоб перевизначити, або нова)'),
      description: z.string().min(10).max(300).optional().describe('Опис; для існуючого можна не вказувати'),
      applies_to:  z.array(z.enum(SKILL_ROLES as unknown as [string, ...string[]])).min(1).optional(),
      body:        z.string().min(20).max(12_000).describe('Повний новий текст скіла (markdown), не diff'),
      reason:      z.string().min(20).max(600).describe('Чому: які дані чи спостереження це обґрунтовують'),
      agent:       z.string().max(40).optional().describe('@handle агента-власника скіла; за замовчуванням — твій оркестратор'),
    }),
    execute: async (i, ctx) => {
      const self = agentOf(ctx);
      if (!self) return { error: 'no_agent', details: 'цей прогін не привʼязаний до агента' };
      const owner = await scopeOwner(d, self);
      let target = owner;
      if (i.agent) {
        const t = await d.agents.getByHandle(i.agent);
        if (!t) return { error: 'unknown_agent', details: i.agent };
        const kids = await d.agents.children(owner.id);
        if (t.id !== owner.id && t.id !== self.id && !kids.some((k) => k.id === t.id)) {
          return { error: 'out_of_scope', details: 'можна змінювати скіли лише свого оркестратора, себе або своїх підлеглих ролей' };
        }
        target = t;
      }
      if (await d.skills.selfEditsToday(self.id) >= SELF_EDITS_PER_DAY) {
        return { error: 'self_edit_limit', details: `не більше ${SELF_EDITS_PER_DAY} самоправки на добу — запиши ідею в памʼять і повернись завтра` };
      }
      const prev = (await d.skills.findForAgent(target.id, i.skill)) ?? (await d.skills.findShared(i.skill));
      const description = i.description ?? prev?.description;
      const appliesTo = i.applies_to ?? prev?.appliesTo;
      if (!description || !appliesTo?.length) return { error: 'new_skill_needs_meta', details: 'для нового скіла потрібні description і applies_to' };

      const t = now();
      const baseline = await d.kpi.primary(target, t).catch(() => null);
      const r = await d.skills.writeAgentSkill({
        agentId: target.id, name: i.skill, description, appliesTo, body: i.body,
        author: 'agent', authorAgentId: self.id, reason: i.reason,
        kpiBaseline: baseline, reviewAt: new Date(t.getTime() + SELF_EDIT_REVIEW_DAYS * 86_400_000),
      });
      if ('error' in r) return r;
      await d.inbox.post({
        agentId: target.id, kind: 'skill_self_edit', severity: 'info',
        title: `✏️ @${self.handle} змінив скіл «${i.skill}» (v${r.version})`,
        body: `Причина: ${i.reason}\n\n${diffLines(prev?.body ?? '', i.body).slice(0, 1200)}\n\nВідкат: сторінка агента → Skills → версії.`,
        refType: 'skill', refId: r.skill.id,
      });
      return { ok: true, skill: i.skill, version: r.version, review_in_days: SELF_EDIT_REVIEW_DAYS, warnings: r.lint.warnings };
    },
  });

  return [proposeSkillEdit];
}
