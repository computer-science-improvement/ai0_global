import type { AgentLoop } from '../harness/agent-loop';
import type { ToolRegistry } from '../harness/tool-registry';
import { resolveModel } from '../llm/model-registry';
import { agentModelIn, readModelContext, type Workspace } from '../llm/workspace';
import type { Agent } from '../agents/agent.types';
import type { AgentRuntime } from '../agents/agent-runtime';
import type { AgentsRepository } from '../agents/agents.repository';
import type { Skill, SkillMeta, SkillSource } from '../skills/skill-library';
import { runChecks } from './checks';
import { buildAuditInput, type AuditSubmission } from './auditor-input';
import { AUDITOR_TOOLS, type AuditRunExtras } from './auditor-tools';
import type { AuditFacts, Finding } from './audit.types';
import { clip } from './audit-text';

/**
 * Spec 055 FR-002: one audit pass. Code runs the checks over the facts; the model (the @sysadmin agent, role `auditor`)
 * reads the findings and the largest texts and answers once with `submit_audit` — a summary, comments on findings and a
 * few findings of its own. Everything the model says is checked in code. The model failing or being switched off never
 * loses the code's findings: the report is the same, without comments.
 */

export const AUDITOR_MAX_STEPS = 8;
export const DEFAULT_AUDITOR_BUDGET_USD = 0.15;
export const AUDITOR_INLINE_SKILLS = ['auditor-workflow'];

export type AuditLlmStatus = 'ok' | 'off' | 'no_agent' | 'budget' | 'failed';

export interface AuditLlmNote {
  status:  AuditLlmStatus;
  /** English, one line, shown in the report (empty when ok). */
  note:    string;
  runId:   string | null;
  costUsd: number;
}

export interface AuditPass {
  facts:    AuditFacts;
  /** Code findings first (by severity), then the model's own. Comments are not applied here. */
  findings: Finding[];
  comments: Record<string, string>;
  summary:  string | null;
  llm:      AuditLlmNote;
}

export interface AuditorRunnerDeps {
  loop:     Pick<AgentLoop, 'run'>;
  registry: Pick<ToolRegistry, 'forRole'>;
  runtime:  Pick<AgentRuntime, 'forAgent'>;
  agents:   Pick<AgentsRepository, 'findTop'>;
  /** AuditQueries.load: the facts from the tables. */
  load:     () => Promise<AuditFacts>;
  env:      (key: string) => string | undefined;
  defaultModel?: (ws?: Workspace) => Promise<string | null>;
  workspace?:    () => Promise<Workspace>;
  now?:     () => Date;
}

const OFF = new Set(['off', '0', 'false', 'no']);

/** Every skill of the database as one `load_skill` source: the auditor reads any of them by name. */
export function skillSourceOf(facts: AuditFacts): SkillSource {
  const byName = new Map<string, Skill>();
  for (const s of facts.skills) {
    if (byName.has(s.name)) continue;
    byName.set(s.name, { name: s.name, description: s.description, appliesTo: s.appliesTo as SkillMeta['appliesTo'], body: s.body, safety: s.safety });
  }
  return {
    list: () => [...byName.values()].map(({ name, description, appliesTo }) => ({ name, description, appliesTo })),
    get: (name) => byName.get(name),
  };
}

export function auditorSystemPrompt(o: { agent: Agent; now: Date; input: string; workflow: string }): string {
  return [
    `Ти — ${o.agent.name} (@${o.agent.handle}), сисадмін медіамережі ai0. Код уже перевірив скіли, памʼять, правила й інструменти і знайшов проблеми; ти додаєш судження. Ти нічого не змінюєш і не публікуєш.`,
    'Відповідаєш одним викликом submit_audit: summary, коментарі до знахідок за ключем і (лише з доказом у текстах) власні знахідки.',
    '',
    `Зараз ${o.now.toISOString().slice(0, 10)}.`,
    '',
    '## Вхід',
    o.input,
    '',
    '## Скіл, завантажений одразу',
    o.workflow || '- немає',
  ].join('\n');
}

/** Findings by severity (error first), then area, then key — the order the report shows them in. */
export function sortFindings(list: Finding[]): Finding[] {
  const rank = { error: 0, warn: 1, info: 2 } as const;
  return [...list].sort((a, b) => rank[a.severity] - rank[b.severity] || a.area.localeCompare(b.area) || a.key.localeCompare(b.key));
}

export class AuditorRunner {
  constructor(private readonly d: AuditorRunnerDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  async agent(): Promise<Agent | null> {
    return this.d.agents.findTop('auditor', 'system', null);
  }

  /** The facts, the checks, then the model pass. Never throws on the model's account. */
  async run(): Promise<AuditPass> {
    const facts = await this.d.load();
    const code = sortFindings(runChecks(facts));
    const llm = await this.model(facts, code);
    if (!llm.submission) {
      return { facts, findings: code, comments: {}, summary: null, llm: llm.note };
    }
    const keys = new Set(code.map((f) => f.key));
    const extra = llm.submission.extra.filter((f) => !keys.has(f.key));
    return { facts, findings: [...code, ...sortFindings(extra)], comments: llm.submission.comments, summary: llm.submission.summary || null, llm: llm.note };
  }

  private async model(facts: AuditFacts, code: Finding[]): Promise<{ note: AuditLlmNote; submission?: AuditSubmission }> {
    const none = (status: AuditLlmStatus, note: string, runId: string | null = null, costUsd = 0): { note: AuditLlmNote } => ({ note: { status, note, runId, costUsd } });
    if (OFF.has((this.d.env('AUDITOR_LLM') ?? '').trim().toLowerCase())) return none('off', 'The model pass is switched off (AUDITOR_LLM): the report has the checks of the code only.');
    const agent = await this.agent();
    if (!agent) return none('no_agent', 'There is no @sysadmin agent: the report has the checks of the code only.');
    if (agent.mode === 'off') return none('off', '@sysadmin is off: the report has the checks of the code only.');

    const ctx = await this.d.runtime.forAgent(agent, 'auditor');
    const all = skillSourceOf(facts);
    const wf = ctx.skills.get(AUDITOR_INLINE_SKILLS[0]) ?? all.get(AUDITOR_INLINE_SKILLS[0]);
    const input = buildAuditInput(code, facts);
    const extras: AuditRunExtras = { allowed: input.allowed };
    const mctx = await readModelContext(this.d);
    const cap = Number(this.d.env('AUDITOR_BUDGET_USD'));
    const maxCostUsd = Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_AUDITOR_BUDGET_USD;

    const res = await this.d.loop.run({
      role: 'auditor', channelKey: null,
      model: resolveModel('auditor', this.d.env, null, { agentModel: agentModelIn(agent, mctx.workspace), defaultModel: mctx.defaultModel, reasoningEffort: agent.reasoningEffort, workspace: mctx.workspace }),
      system: auditorSystemPrompt({ agent, now: this.now(), input: input.text, workflow: wf ? `### skill: ${wf.name}\n${wf.body}` : '' }),
      user: 'Прочитай знахідки й тексти. Якщо щось треба глянути докладніше — один-два виклики читання. Потім submit_audit.',
      tools: this.d.registry.forRole('auditor').filter((t) => AUDITOR_TOOLS.has(t.name)),
      maxSteps: AUDITOR_MAX_STEPS, maxCostUsd,
      agent: { id: agent.id, handle: agent.handle, limitUsd: agent.dailyBudgetUsd ?? null },
      extras: { agent, skills: all, audit: extras },
    });
    const costUsd = res.totals?.costUsd ?? 0;
    if (res.status === 'disabled') return none('off', 'No model key is set: the report has the checks of the code only.', res.runId, costUsd);
    if (res.status === 'budget_exceeded') return none('budget', 'The audit budget ran out: the report has the checks of the code only.', res.runId, costUsd);
    if (res.terminalTool !== 'submit_audit' || !extras.submission) {
      return none('failed', `The model gave no summary (${res.status}${res.error ? `: ${clip(res.error, 120)}` : ''}): the report has the checks of the code only.`, res.runId, costUsd);
    }
    return { note: { status: 'ok', note: '', runId: res.runId, costUsd }, submission: extras.submission };
  }
}
