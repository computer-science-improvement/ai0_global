import type { AgentLoop, AgentLoopResult } from '../harness/agent-loop';
import type { ToolRegistry } from '../harness/tool-registry';
import { resolveModel } from '../llm/model-registry';
import { agentModelIn, readModelContext, type Workspace } from '../llm/workspace';
import type { Agent } from '../agents/agent.types';
import { isPaused } from '../agents/agent.types';
import type { AgentRuntime } from '../agents/agent-runtime';
import { intersectAllow, type LoadoutService } from '../loadout/loadout.service';
import type { AgentsRepository } from '../agents/agents.repository';
import type { OwnerInbox } from '../agents/owner-inbox';
import { localDate, localTimeLabel, zonedToUtc } from '../roles/time';
import type { Directive, DirectivesRepository } from './directives.repository';
import { reviewSignature, type KpiDigest, type KpiDigestService } from './kpi-digest.service';
import { ESCALATION_DAYS, notFollowedNote, postsNote, postsRuns, type EscalationNote } from './escalation';
import { dayBefore, type ScopeKpis } from './kpi-math';
import { DirectiveExecution, PROMO_KINDS } from './executors';
import { isQualityMetric, qualityMetricValue } from './quality-digest';
import { requiredQualityRefs } from './directive-tools';

/**
 * Spec 046 FR-004: two looks a day (the skip rule makes the second one cheap when nothing changed); was four.
 * Spec 069 FR-005: one look a day. Review 4: the evening run mostly re-read the morning's digest, and the escalations
 * (hourly, by code) no longer wait for a look to be raised.
 */
export const DEFAULT_MANAGER_TIMES = ['09:00'];
/** Spec 046 FR-004: the manager's own daily cap when the owner set none (review 2: the Opus manager spent $1.67 a day). */
export const DEFAULT_MANAGER_DAILY_USD = 0.6;

/** Spec 053 FR-006: the scheduled review's turn cap (was 20 — a review is: read, file up to 3, submit). */
export const MANAGER_MAX_STEPS = 12;
export const MANAGER_INLINE_SKILLS = ['manager-workflow'];
/**
 * Spec 053 FR-006: the tools of the scheduled review. The digest is in the prompt; library, feeds, web and dataset
 * edits are not a manager's work, and every tool schema is re-sent on every step. The owner's chat with the manager
 * keeps its own set.
 */
export const MANAGER_TOOLS = new Set([
  'get_kpi_digest', 'file_directive', 'list_directives', 'submit_review', 'explain_decision', 'get_network_posts', 'get_platform_stats',
  'sql_readonly', 'list_ideas', 'list_series', 'get_playbook', 'list_agents', 'get_agent', 'propose_skill_edit', 'load_skill',
]);
export const DELIVERY_DEBOUNCE_MS = 10 * 60_000;
export const WAKE_INTERVAL_MS = 60 * 60_000;
/**
 * Spec 046 FR-007: directive kinds that wake an orchestrator before its daily run — they need new ideas or posts.
 * The rest wait for the daily run (unanswered() gives a never-delivered directive twice the answer window).
 */
export const WAKE_KINDS = ['task', 'experiment', 'cross_promo'] as const;
export const RESOLVE_WITHIN_MS = 24 * 3600_000;
export const NOT_RESPONDING_AFTER = 5;

export interface ManagerRunnerDeps {
  loop:     Pick<AgentLoop, 'run'>;
  registry: Pick<ToolRegistry, 'forRole'>;
  runtime:  Pick<AgentRuntime, 'forAgent'>;
  /** Spec 054: the manager's own tool set (intersected with MANAGER_TOOLS). Optional for tests. */
  loadout?: Pick<LoadoutService, 'allowFor'>;
  agents:   Pick<AgentsRepository, 'findTop' | 'get' | 'list'>;
  repo:     DirectivesRepository;
  digest:   Pick<KpiDigestService, 'build' | 'render' | 'snapshot'>;
  /** `postOnce` (spec 069 FR-005) is what the escalations use; without it `escalate()` does nothing. */
  inbox:    Pick<OwnerInbox, 'post'> & Partial<Pick<OwnerInbox, 'postOnce'>>;
  env:      (key: string) => string | undefined;
  /** The owner's global default model (spec 035, app_settings `ai.default_model`); cached by ModelDefaultsStore. */
  defaultModel?: (ws?: Workspace) => Promise<string | null>;
  /** Spec 038: the active model workspace. */
  workspace?: () => Promise<Workspace>;
  /** Hours an owner card waits before its default action, and the kinds whose default is "apply". */
  timeoutHours?: number;
  timeoutApplyKinds?: string[];
  /** Spec 025 FR-009: the executors. Without it no kind has one (advice self-reported; T4/T5 kinds unverified; the rest fail). */
  exec?:    DirectiveExecution;
  /** Spec 025 FR-008: hours a contested directive waits for the owner before the refusal stands (DIRECTIVE_CONTEST_TIMEOUT_HOURS). */
  contestTimeoutHours?: number;
  /** Spec 025 FR-008: the health guard on uphold (ResourceHealthService.usable). */
  usable?:  (ref: string) => Promise<boolean>;
  now?:     () => Date;
}

/** Spec 025 FR-007: the resolution of a binding directive the code applied because nobody answered it. */
export const AUTO_APPLIED = 'auto-applied: no response';
export const DEFAULT_CONTEST_TIMEOUT_HOURS = 24;

/** The resources a directive's params name (for the health guard on uphold). */
export function paramRefs(params: Record<string, unknown> | null | undefined): string[] {
  const p = params ?? {};
  return ['resource_ref', 'source_ref', 'target_ref', 'to_ref'].map((k) => p[k]).filter((x): x is string => typeof x === 'string' && x.includes(':'));
}

export type OwnerDecisionResult = { directive: Directive } | { error: 'directive_not_found' | 'not_contested' | 'not_executable'; details?: string };

/** Spec 025 FR-017: how a delivered item is marked for the orchestrator. */
export function bindingLabel(x: Pick<Directive, 'binding'>): string {
  return x.binding === 'advice' ? 'порада (на твій розсуд)' : 'ДИРЕКТИВА (обовʼязково)';
}

/**
 * Spec 060 FR-005: what the manager does with the "виконання" (adherence) of an open directive and with a paused series.
 * Review 3: advice nobody followed counted as cover, and the manager kept silent about it.
 */
export const NOT_FOLLOWED_LINES = [
  'У списку відкритих директив «виконання not_followed» означає, що застосовану пораду оркестратор не виконав — вона нічого не покриває. Один раз не виконано: подай те саме як директиву (binding: directive) з supersedes на стару пораду. Не виконано двічі (директиву теж): ескалюй власнику — структурна директива, яка піде йому на рішення. «inconclusive» — без вимірюваного ефекту, не повторюй її слово в слово.',
  'Серія на паузі (signals: series_paused у дайджесті) зупинена кодом після кількох пропусків поспіль: не радь планувати її знову — це рішення власника (Відновити). Критик, що відхиляє 3 пости поспіль (signals: critic_streak), і dark_day — привід для voice_fix / format_mix, навіть коли відкрита директива вже є.',
];

/**
 * Spec 069 FR-005: what the manager does with the digest's `escalations` (open «ескалація власнику» notes the code raised).
 * `submit_review` refuses a review that leaves one unanswered.
 */
export const ESCALATION_LINES = [
  'Блок escalations у дайджесті — ескалації, які код уже підняв власнику (поради не виконано двічі за 14 днів; кількість постів нижча за норму три дні поспіль без директив). Це не нова порада: відповідай на кожну в submit_review.escalations — або directive_id (директива цьому агенту, подана в цьому прогоні й названа в directive_ids), або decline_reason (≥ 20 символів, чому директива зараз не потрібна). Рядки відкритих директив із «не виконано — ескалюй» не дублюй порадою.',
];

/** System prompt of the scheduled manager run. */
export function managerSystemPrompt(o: { agent: Agent; now: Date; digest: string; memory: string; skills: { inline: string; listed: string }; open?: KpiDigest['directives']['open']; qualityRefs?: string[] }): string {
  const tz = 'Europe/Kyiv';
  return [
    `Ти — ${o.agent.name} (@${o.agent.handle}), менеджер медіамережі ai0. Бачиш усі ресурси, KPI, якість текстів і директиви. Ти НЕ публікуєш і не керуєш постами напряму — лише даєш поради й директиви оркестраторам.`,
    'Кожен прогін — два аудити: цифри (KPI) і якість контенту (блок quality у дайджесті: вердикти критика, опитування й питання до читачів проти лімітів, відхилення й правки власника, зразки текстів). Чекліст якості зі скіла manager-workflow проходиш по кожному активному ресурсу з доказами з дайджесту.',
    '«continue» (submit_review) — лише після чекліста: quality_check по кожному ресурсу з цифрами чи цитатами. Проблема з якістю (тексти звучать як ШІ, безглузді, забагато опитувань чи питань, власник відхиляє чи править) — це порада voice_fix або format_mix, а не «все гаразд». Директива на KPI — коли цифри дають конкретну підставу (аномалія, стійкий тренд, явна можливість).',
    'Правила власника важливіші за твої директиви. Не давай директив на метриках зі stale. Не більше 3 директив за прогін. Не мікроменеджь окремі пости — працюй через правила, приклади, ваги й ліміти.',
    'Кожну подаєш з binding: порада (advice, за замовчуванням — оркестратор може відхилити) або директива (directive, обовʼязкова — лише при anomaly чи ескалації; структурні — завжди директива).',
    // Spec 060 FR-005: advice nobody followed is not "in force"; a series stopped by code is not advised again.
    ...NOT_FOLLOWED_LINES,
    ...ESCALATION_LINES,
    '',
    `Зараз ${localDate(o.now, tz)} ${localTimeLabel(o.now, tz)} (Київ).`,
    '',
    '## Дайджест: KPI (7 днів проти 28-денної норми; d — зміна %, z — у шумах) і quality по ресурсах (7 днів)',
    o.digest,
    '',
    ...(o.qualityRefs ? ['## quality_check обовʼязковий для (решта — за бажанням)', o.qualityRefs.length ? o.qualityRefs.join(', ') : '- нікого: verdict continue з quality_check: [] — можна', ''] : []),
    '## Відкриті директиви (не дублюй; прийняту чи застосовану того ж типу замінюй лише через supersedes)',
    openDirectivesText(o.open ?? []),
    '',
    '## Памʼять менеджера (уроки минулих директив)',
    o.memory || '- (порожня)',
    '',
    '## Скіли, завантажені одразу',
    o.skills.inline || '- немає',
    '',
    '## Інші скіли (load_skill)',
    o.skills.listed || '- немає',
  ].join('\n');
}

/** Spec 046 FR-003: accepted / applied directives as the planner reads them (the orchestrator's plan is the resolution). */
export function commitmentsText(list: Array<Pick<Directive, 'kind' | 'binding' | 'status' | 'body' | 'resolution' | 'reviewAt'>>): string | null {
  if (!list.length) return null;
  return list.map((x) => [
    `- ${bindingLabel(x)} · ${x.kind} · ${x.status}${x.reviewAt ? ` · перевірка ${x.reviewAt.toISOString().slice(0, 10)}` : ''}: ${x.body.slice(0, 300)}`,
    x.resolution ? `  план оркестратора: ${x.resolution.slice(0, 300)}` : '',
  ].filter(Boolean).join('\n')).join('\n');
}

/** Spec 040 FR-007: the open directives as the manager prompt lists them — target, kind, binding, status, review date. */
export function openDirectivesText(open: KpiDigest['directives']['open']): string {
  if (!open.length) return '- немає';
  // Spec 060 FR-005: whether the advice was followed (adherence) and its age, so a not_followed one is not mistaken for in force.
  // Spec 069 FR-005: an evaluated row stays in the list only because nobody followed it — it is for escalating, not for repeating.
  return open.map((x) => `- @${x.to} · ${x.kind}${x.binding ? ` (${x.binding})` : ''} · ${x.status}${x.adherence ? ` · виконання ${x.adherence}` : ''}${x.status === 'evaluated' && x.adherence === 'not_followed' ? ' · не виконано — ескалюй, не дублюй як пораду' : ''}${x.ageDays != null ? ` · ${x.ageDays} дн.` : ''} · перевірка ${x.reviewAt?.slice(0, 10) ?? '—'} · id ${x.id}`).join('\n');
}

/**
 * Spec 021 skip rule, extended by spec 034 FR-006: a run without an LLM call when the digest hash (KPIs, open
 * directives and the quality signature) is the same as at the last review and no KPI anomaly is flagged.
 * Spec 040 FR-007: also when the review signature (KPI anomalies + quality flags of the resources with an agent)
 * equals the last review's — unless no LLM review ran yet today (Kyiv): at most one forced review a day.
 */
export function canSkip(
  last: { digestHash: string | null; signature?: string | null; lastRunAt?: Date | null } | null,
  digest: Pick<KpiDigest, 'hash' | 'resources'> & { directives?: Pick<KpiDigest['directives'], 'open'> },
  o: { now?: Date } = {},
): boolean {
  if (!last) return false;
  if (last.digestHash === digest.hash && !digest.resources.some((r) => r.anomalies.length)) return true;
  if (!last.signature || last.signature !== reviewSignature(digest)) return false;
  const now = o.now ?? new Date();
  return !!last.lastRunAt && localDate(last.lastRunAt, 'Europe/Kyiv') === localDate(now, 'Europe/Kyiv');
}

/**
 * The MANAGER's schedule and the directive lifecycle housekeeping (spec 021):
 * runs at its times, skips without an LLM when nothing changed, delivers
 * directives to orchestrators, applies owner-card timeouts, expires
 * unresolved directives and evaluates effects.
 */
export class ManagerRunner {
  private readonly done = new Set<string>();

  readonly exec: DirectiveExecution;

  constructor(private readonly d: ManagerRunnerDeps) {
    this.exec = d.exec ?? new DirectiveExecution({ repo: d.repo, inbox: d.inbox, agents: d.agents, context: async () => null, executors: [], now: d.now });
  }

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  async manager(): Promise<Agent | null> {
    return this.d.agents.findTop('manager', 'system', null);
  }

  /** Is a scheduled time due now (once per time per day)? */
  dueSlot(agent: Agent, now: Date): string | null {
    const tz = 'Europe/Kyiv';
    const hm = localTimeLabel(now, tz);
    const day = localDate(now, tz);
    const times = agent.schedule?.times?.length ? agent.schedule.times : DEFAULT_MANAGER_TIMES;
    const due = times.filter((t) => t <= hm).sort().pop();
    if (!due) return null;
    const key = `${day}@${due}`;
    return this.done.has(key) ? null : key;
  }

  /**
   * Scheduler tick entry point. Spec 046 FR-004: a due time is done when a review (run or skip) was stored after it —
   * the in-memory set alone ran the same time again after every restart (review 2: 6/16 runs off-schedule).
   */
  async tick(): Promise<AgentLoopResult | { skipped: string } | null> {
    const m = await this.manager();
    if (!m || m.mode === 'off' || isPaused(m, this.now())) return null;
    const key = this.dueSlot(m, this.now());
    if (!key) return null;
    this.done.add(key);
    const [day, hm] = key.split('@');
    const last = await this.d.repo.lastReview().catch(() => null);
    if (last?.createdAt && new Date(last.createdAt).getTime() >= zonedToUtc(day, hm, 'Europe/Kyiv').getTime()) return null;
    return this.run(m);
  }

  async run(m: Agent): Promise<AgentLoopResult | { skipped: string }> {
    const digest = await this.d.digest.build();
    try { await this.d.digest.snapshot(digest); } catch { /* snapshots are best-effort */ }
    const last = await this.d.repo.lastReview();
    const signature = reviewSignature(digest);
    if (canSkip(last, digest, { now: this.now() })) {
      await this.d.repo.addReview({ verdict: 'skipped', summary: 'без змін з минулого прогону', digestHash: digest.hash, signature });
      return { skipped: 'digest unchanged, no anomalies' };
    }
    const ctx = await this.d.runtime.forAgent(m, 'manager');
    const memory = (await this.d.repo.memory(m.id)).map((x) => `- [${x.kind}${x.createdBy === 'owner' ? ', власник' : ''}] ${x.text}`).join('\n');
    // Spec 053 FR-006: the workflow inline; kpi-reading (how z, anomaly, insufficient read) is listed and loaded on demand.
    const inlineSkill = MANAGER_INLINE_SKILLS.map((n) => ctx.skills.get(n)).filter(Boolean).map((s) => `### skill: ${s!.name}\n${s!.body}`).join('\n\n');
    const listed = ctx.skills.list('manager').filter((s) => !MANAGER_INLINE_SKILLS.includes(s.name)).map((s) => `- ${s.name}: ${s.description}`).join('\n');
    const mctx = await readModelContext(this.d);
    const loadoutAllow = this.d.loadout ? await this.d.loadout.allowFor(m, { role: 'manager', registry: this.d.registry }) : null;
    const res = await this.d.loop.run({
      role: 'manager', channelKey: null, model: resolveModel('manager', this.d.env, null, { agentModel: agentModelIn(m, mctx.workspace), defaultModel: mctx.defaultModel, reasoningEffort: m.reasoningEffort, workspace: mctx.workspace }),
      system: managerSystemPrompt({ agent: m, now: this.now(), digest: this.d.digest.render(digest), memory, skills: { inline: inlineSkill, listed }, open: digest.directives?.open, qualityRefs: requiredQualityRefs(digest) }),
      user: 'Проаналізуй дайджест: KPI і якість контенту по кожному ресурсу (чекліст якості). Є підстава — file_directive (до 3; для якості — voice_fix / format_mix) і submit_review directives. Нічого робити не треба — submit_review continue, але з quality_check по кожному активному ресурсу з доказами.',
      tools: this.d.registry.forRole('manager', intersectAllow(null, loadoutAllow)).filter((t) => MANAGER_TOOLS.has(t.name)), maxSteps: MANAGER_MAX_STEPS,
      agent: { id: m.id, handle: m.handle, limitUsd: m.dailyBudgetUsd ?? DEFAULT_MANAGER_DAILY_USD },
      extras: { agent: m, skills: ctx.skills, digest },
    });
    if (res.terminalTool !== 'submit_review') {
      await this.d.repo.addReview({ runId: res.runId, verdict: 'continue', summary: `прогін без підсумку (${res.status}${res.error ? `: ${res.error}` : ''})`, digestHash: digest.hash, signature });
    }
    return res;
  }

  /** Orchestrators that have fresh directives (debounced) — the scheduler gives them an event run. */
  private readonly woken = new Map<string, number>();

  /** At most one event run per orchestrator per WAKE_INTERVAL_MS, whatever the outcome of the last one. */
  async orchestratorsToWake(): Promise<Agent[]> {
    const ids = await this.d.repo.undeliveredTargets(DELIVERY_DEBOUNCE_MS, WAKE_KINDS);
    const out: Agent[] = [];
    const t = this.now().getTime();
    for (const id of ids) {
      if (t - (this.woken.get(id) ?? 0) < WAKE_INTERVAL_MS) continue;
      const a = await this.d.agents.get(id);
      if (a && !isPaused(a, this.now())) { out.push(a); this.woken.set(id, t); }
    }
    return out;
  }

  /** Inbox text for an orchestrator prompt; marks the directives delivered. */
  async deliver(orch: Agent): Promise<string | null> {
    const list = await this.d.repo.inbox(orch.id);
    if (!list.length) return null;
    await this.d.repo.markDelivered(list.map((x) => x.id));
    return list.map((x) => [
      `- ${bindingLabel(x)} · id ${x.id} · ${x.kind}${x.structural ? ' (затверджено власником)' : ''}: ${x.body}`,
      `  чому: ${x.rationale}`,
      x.expected ? `  очікуємо: ${x.expected.metric} ${x.expected.direction === 'up' ? '↑' : '↓'} ≥ ${x.expected.min_change_pct}% до ${x.reviewAt?.toISOString().slice(0, 10)}` : '',
      Object.keys(x.params ?? {}).length ? `  параметри: ${JSON.stringify(x.params)}` : '',
    ].filter(Boolean).join('\n')).join('\n');
  }

  /** Spec 046 FR-003: the planner's block of what the orchestrator accepted (null when nothing is in force). */
  async commitments(orchestratorId: string): Promise<string | null> {
    const list = await this.d.repo.inForce(orchestratorId);
    return commitmentsText(list);
  }

  /**
   * After an orchestrator run (spec 025 FR-009): every accepted (non-promo) directive goes through its executor;
   * the ones applied get their baseline. Failures are counted and retried hourly (failed after 3).
   */
  async afterOrchestration(orch: Agent, digest?: KpiDigest | null): Promise<Directive[]> {
    const done = await this.exec.executeAccepted(orch);
    const applied = done.filter((x) => x.status === 'applied');
    for (const dir of applied) await this.recordBaseline(dir, digest ?? null);
    return applied;
  }

  private async ensureHandles(): Promise<void> {
    if (this.handleCache.size) return;
    for (const a of await this.d.agents.list()) this.handleCache.set(a.id, a.handle);
  }

  async recordBaseline(dir: Directive, digest: KpiDigest | null): Promise<void> {
    if (!dir.expected) return;
    await this.ensureHandles();
    const dg = digest ?? await this.d.digest.build();
    const before = this.metricFor(dg, dir);
    const days = dir.reviewAt && dir.createdAt ? Math.max(3, Math.round((dir.reviewAt.getTime() - dir.createdAt.getTime()) / 86_400_000)) : 7;
    await this.d.repo.update(dir.id, { outcomeDetail: { before }, reviewAt: new Date(this.now().getTime() + days * 86_400_000) });
  }

  private metricFor(dg: KpiDigest, dir: Directive): { value: number | null; stale: boolean; resources: string[] } | null {
    if (!dir.expected) return null;
    const metric = dir.expected.metric;
    const refs = dg.resources.filter((r) => (dir.expected!.resource_ref ? r.ref === dir.expected!.resource_ref : r.agent && r.agent === this.handleCache.get(dir.toAgentId)));
    // Spec 034 FR-006: a quality metric (%) comes from the resources' quality block; no data = stale.
    if (isQualityMetric(metric)) {
      const q = refs.map((r) => qualityMetricValue(r.quality, metric)).filter((v): v is number => v != null);
      return { value: q.length ? q.reduce((a, b) => a + b, 0) / q.length : null, stale: q.length === 0, resources: refs.map((r) => r.ref) };
    }
    const vals = refs.map((r) => (dg.raw.get(r.ref) as ScopeKpis | undefined)?.[metric as keyof ScopeKpis]).filter(Boolean);
    const nums = vals.map((v) => v!.value7d).filter((v): v is number => v != null);
    return { value: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null, stale: vals.length > 0 && vals.every((v) => v!.stale), resources: refs.map((r) => r.ref) };
  }

  private readonly handleCache = new Map<string, string>();

  /**
   * Spec 025 FR-007: directives nobody answered. Advice expires silently. A binding directive whose target is
   * paused or off (or that was never delivered) expires with an info entry; one with an executor is applied by
   * the code (`directive_auto_applied`, info); one without (`task`) expires as `directive_ignored` (action).
   */
  async resolveUnanswered(): Promise<{ expired: number; autoApplied: number; ignored: number }> {
    const out = { expired: 0, autoApplied: 0, ignored: 0 };
    out.expired += await this.d.repo.expireShadowUnanswered(RESOLVE_WITHIN_MS);
    for (const dir of await this.d.repo.unanswered(RESOLVE_WITHIN_MS)) {
      const orch = await this.d.agents.get(dir.toAgentId);
      const who = orch ? `@${orch.handle}` : 'the orchestrator';
      if (dir.binding === 'advice') {
        if (await this.d.repo.update(dir.id, { status: 'expired', resolution: 'not resolved within 24 h' }, ['new'])) out.expired++;
        continue;
      }
      const inactive = !orch || orch.mode === 'off' || isPaused(orch, this.now());
      if (inactive || !dir.deliveredAt) {
        const why = inactive ? `${who} is ${orch?.mode === 'off' ? 'off' : 'paused'}` : `it was never delivered to ${who}`;
        if (!await this.d.repo.update(dir.id, { status: 'expired', resolution: `expired: ${why}` }, ['new'])) continue;
        out.expired++;
        await this.d.inbox.post({
          agentId: dir.toAgentId, kind: 'directive_expired', severity: 'info',
          title: `⌛ Directive for ${who} expired: ${dir.kind}`,
          body: `${dir.body}\n\nNot answered within 24 h: ${why}.`,
          alert: { title: `⌛ Директива для ${who} спливла: ${dir.kind}`, body: `${dir.body}\n\nБез відповіді 24 год: ${inactive ? 'агент на паузі або вимкнений' : 'не доставлена'}.` },
          refType: 'directive', refId: dir.id,
        });
        continue;
      }
      const executable = !!this.exec.executorFor(dir.kind) || PROMO_KINDS.includes(dir.kind);
      if (!executable) {
        if (!await this.d.repo.update(dir.id, { status: 'expired', resolution: `ignored: ${who} did not answer within 24 h` }, ['new'])) continue;
        out.ignored++;
        await this.d.inbox.post({
          agentId: dir.toAgentId, kind: 'directive_ignored', severity: 'action',
          title: `🙈 ${who} ignored a directive from @manager: ${dir.kind}`,
          body: `${dir.body}\n\nNo answer within 24 h, and the code cannot carry out a ${dir.kind} itself. Check the agent or give it the task in chat.`,
          alert: { title: `🙈 ${who} проігнорував директиву @manager: ${dir.kind}`, body: `${dir.body}\n\nБез відповіді 24 год; код сам цього не виконає.` },
          refType: 'directive', refId: dir.id,
        });
        continue;
      }
      const acc = await this.d.repo.update(dir.id, { status: 'accepted', resolution: AUTO_APPLIED }, ['new']);
      if (!acc) continue;
      // Promo kinds are scheduled by PromoPlanner after the orchestrator's next run (spec 022).
      const done = PROMO_KINDS.includes(dir.kind) ? acc : (await this.exec.execute(acc, orch!)) ?? acc;
      if (done.status === 'applied') await this.recordBaseline(done, null);
      out.autoApplied++;
      const state = done.status === 'applied' ? 'applied' : PROMO_KINDS.includes(dir.kind) ? 'scheduled with the next orchestrator run' : `not applied yet (${done.execError ?? 'retrying hourly'})`;
      await this.d.inbox.post({
        agentId: dir.toAgentId, kind: 'directive_auto_applied', severity: 'info',
        title: `🤖 Directive for ${who} applied without an answer: ${dir.kind}`,
        body: `${dir.body}\n\n${who} did not answer within 24 h, so the code carried it out: ${state}.`,
        alert: { title: `🤖 Директиву для ${who} застосовано без відповіді: ${dir.kind}`, body: `${dir.body}\n\n${who} не відповів за 24 год — код виконав її сам.` },
        refType: 'directive', refId: dir.id,
      });
    }
    return out;
  }

  /** FR-008: contested directives the owner did not decide in time — the refusal stands (rejected, timeout_dropped). */
  async contestTimeouts(): Promise<number> {
    const hours = this.d.contestTimeoutHours ?? DEFAULT_CONTEST_TIMEOUT_HOURS;
    let n = 0;
    for (const dir of await this.d.repo.contestedOlderThan(hours * 3600_000)) {
      if (await this.d.repo.update(dir.id, { status: 'rejected', ownerDecision: 'timeout_dropped' }, ['contested'])) n++;
    }
    return n;
  }

  /**
   * FR-008: the owner upholds a contested directive. The owner-rule check is skipped (the owner decided), but the
   * capability (the executor's plan) and health guards still apply; then the executor runs.
   */
  async uphold(id: string): Promise<OwnerDecisionResult> {
    const dir = await this.d.repo.get(id);
    if (!dir) return { error: 'directive_not_found' };
    if (dir.status !== 'contested') return { error: 'not_contested', details: dir.status };
    const orch = await this.d.agents.get(dir.toAgentId);
    if (!orch) return { error: 'not_executable', details: 'the target orchestrator is gone' };
    if (this.exec.executorFor(dir.kind)) {
      const dry = await this.exec.dryRun(dir, orch);
      if (dry && 'error' in dry) return { error: 'not_executable', details: dry.details };
    }
    if (this.d.usable) {
      for (const ref of paramRefs(dir.params)) {
        if (!(await this.d.usable(ref).catch(() => true))) return { error: 'not_executable', details: `${ref} is not usable now (resource health)` };
      }
    }
    const acc = await this.d.repo.update(id, { status: 'accepted', ownerDecision: 'upheld' }, ['contested']);
    if (!acc) return { error: 'not_contested', details: (await this.d.repo.get(id))?.status };
    // Promo kinds are scheduled by PromoPlanner after the orchestrator's next run (spec 022); the rest run now.
    if (!PROMO_KINDS.includes(dir.kind)) {
      const r = await this.exec.execute(acc, orch);
      if (r?.status === 'applied') await this.recordBaseline(r, null);
    }
    return { directive: (await this.d.repo.get(id))! };
  }

  /** FR-008: the owner sides with the orchestrator — rejected, the 48 h cooldown starts, the MANAGER learns it. */
  async acceptRefusal(id: string): Promise<OwnerDecisionResult> {
    const dir = await this.d.repo.get(id);
    if (!dir) return { error: 'directive_not_found' };
    if (dir.status !== 'contested') return { error: 'not_contested', details: dir.status };
    const out = await this.d.repo.update(id, { status: 'rejected', ownerDecision: 'refusal_accepted' }, ['contested']);
    if (!out) return { error: 'not_contested', details: (await this.d.repo.get(id))?.status };
    const m = await this.manager();
    if (m) {
      await this.ensureHandles();
      await this.d.repo.addMemory(m.id, 'insight',
        `Власник став на бік @${this.handleCache.get(dir.toAgentId) ?? '?'} щодо ${dir.kind} (${dir.reasonKind ?? '—'}): ${String(dir.resolution ?? '').slice(0, 200)}`,
        { directive: dir.id }, 'system');
    }
    return { directive: out };
  }

  /** Owner-card timeouts, unresolved expiry, executor retries, series resumes, verification, effect evaluation (hourly). */
  async housekeeping(): Promise<{ timedOut: number; expired: number; evaluated: number; executed: number; failed: number; resumed: number; verified: number; autoApplied: number; ignored: number; contestTimedOut: number; escalated: number }> {
    for (const a of await this.d.agents.list()) this.handleCache.set(a.id, a.handle);
    let timedOut = 0;
    const hours = this.d.timeoutHours ?? 12;
    for (const dir of await this.d.repo.awaitingOwnerOlderThan(hours * 3600_000)) {
      const apply = (this.d.timeoutApplyKinds ?? []).includes(dir.kind);
      await this.d.repo.update(dir.id, apply ? { status: 'new', ownerDecision: 'timeout_applied' } : { status: 'expired', ownerDecision: 'timeout_dropped', resolution: 'owner did not answer' }, ['awaiting_owner']);
      timedOut++;
    }
    const m = await this.manager();
    if (timedOut && m && await this.d.repo.droppedInARow() === NOT_RESPONDING_AFTER) {
      await this.d.repo.addMemory(m.id, 'insight', 'Власник не відповідає на структурні директиви (5 поспіль скасовано за таймаутом) — пропонуй їх рідше і лише з сильними підставами.', null, 'system');
    }
    const { expired, autoApplied, ignored } = await this.resolveUnanswered();
    const contestTimedOut = await this.contestTimeouts();
    // Spec 025 FR-009: retry executors, resume paused series, verify applied changes — before evaluating.
    const retried = await this.exec.retryPending();
    const executed = retried.filter((x) => x.status === 'applied');
    for (const dir of executed) await this.recordBaseline(dir, null);
    const failed = retried.filter((x) => x.status === 'failed').length;
    const resumed = await this.exec.resumeSeries();
    const verified = await this.exec.verifyApplied();
    // Spec 069 FR-005: advice nobody followed and posts below the norm are raised to the owner by code, after the verification above.
    const escalated = await this.escalate().catch(() => 0);
    // Spec 025 FR-014/FR-015: experiment quotas past their deadline, tasks never reported done.
    const quotasFailed = await this.exec.closeQuotas();
    const overdue = await this.expireOverdueTasks();
    const evaluated = await this.evaluate();
    return { timedOut, expired: expired + overdue, evaluated, executed: executed.length, failed: failed + quotasFailed, resumed, verified, autoApplied, ignored, contestTimedOut, escalated };
  }

  /**
   * Spec 069 FR-005: the manager escalates by code (no LLM). Trigger 1: two or more pieces of advice / directives to one agent
   * and kind that nobody followed within 14 days. Trigger 2: a negative posts anomaly on 3 or more days in a row for an
   * agent that got no directive in that span. Each becomes one gated Inbox note (`postOnce`: the same causes say nothing again)
   * and one line in the manager's memory. Returns the number of notes posted.
   */
  async escalate(): Promise<number> {
    const { inbox, repo } = this.d;
    if (!inbox.postOnce || !repo.notFollowedGroups || !repo.negativePostsDays || !repo.filedSince) return 0;
    const now = this.now();
    const day = localDate(now, 'Europe/Kyiv');
    const m = await this.manager();
    const notes: EscalationNote[] = (await repo.notFollowedGroups(ESCALATION_DAYS)).map((g) => notFollowedNote(g, day));
    const rows = await repo.negativePostsDays(dayBefore(day, 10));
    for (const r of postsRuns(rows, day)) {
      // "No directive filed in that span": the agent was told something since the run began (a shadow directive does not count).
      if (await repo.filedSince(r.agentId, zonedToUtc(r.firstDay, '00:00', 'Europe/Kyiv')) === 0) notes.push(postsNote(r, day));
    }
    let n = 0;
    for (const note of notes) {
      if (await inbox.postOnce(note.item) == null) continue;
      n++;
      if (m) {
        try { await repo.addMemory(m.id, 'avoid', note.memory.text, note.memory.evidence, 'system'); } catch { /* memory is best-effort */ }
      }
    }
    return n;
  }

  /** Spec 025 FR-015: an accepted task not reported done by its review date expires (binding: `directive_ignored`, action). */
  async expireOverdueTasks(): Promise<number> {
    if (!this.d.repo.overdueTasks) return 0;
    let n = 0;
    for (const dir of await this.d.repo.overdueTasks(this.now())) {
      if (!await this.d.repo.update(dir.id, { status: 'expired', resolution: 'not reported done by the review date' }, ['accepted'])) continue;
      n++;
      if (dir.binding !== 'directive') continue;
      await this.ensureHandles();
      const who = `@${this.handleCache.get(dir.toAgentId) ?? '?'}`;
      await this.d.inbox.post({
        agentId: dir.toAgentId, kind: 'directive_ignored', severity: 'action',
        title: `🙈 ${who} accepted a task from @manager but never reported it done`,
        body: `${dir.body}\n\nAccepted ("${dir.resolution ?? '—'}"), but no report_directive_done by ${dir.reviewAt?.toISOString().slice(0, 10) ?? 'the review date'}.`,
        alert: { title: `🙈 ${who} прийняв завдання @manager, але не відзвітував`, body: `${dir.body}\n\nНемає report_directive_done до дати перевірки.` },
        refType: 'directive', refId: dir.id,
      });
    }
    return n;
  }

  /**
   * Spec 060 FR-005: one agent_memory line for a directive that was not followed (`avoid`) or whose effect could not be judged
   * (`insight`), with the directive id — the same as `worked` / `hurt` write today.
   */
  private async rememberUnscored(managerId: string, dir: Directive, adherence: string | null): Promise<void> {
    const who = `@${this.handleCache.get(dir.toAgentId) ?? '?'}`;
    const what = `${dir.kind} для ${who} (${dir.body.slice(0, 120)})`;
    try {
      if (adherence === 'not_followed') {
        await this.d.repo.addMemory(managerId, 'avoid', `${what} — оркестратор не виконав: не ставити тієї самої поради знову, а ескалювати.`, { directive: dir.id, adherence }, 'system');
      } else {
        await this.d.repo.addMemory(managerId, 'insight', `${what} — ефект не вдалося оцінити (inconclusive${adherence ? `, виконання ${adherence}` : ''}).`, { directive: dir.id, adherence }, 'system');
      }
    } catch { /* memory is best-effort */ }
  }

  /** Effect of applied directives on their review date (FR-007). */
  async evaluate(): Promise<number> {
    const due = await this.d.repo.dueForEvaluation(this.now());
    if (!due.length) return 0;
    await this.ensureHandles();
    const dg = await this.d.digest.build();
    const m = await this.manager();
    let n = 0;
    for (const dir of due) {
      const before = (dir.outcomeDetail as any)?.before as { value: number | null } | undefined;
      const vkind = (dir.verification as { kind?: string } | null)?.kind ?? null;
      // FR-015: followed advice is self-reported — closed at its review date, never scored.
      if (vkind === 'self_reported') {
        await this.d.repo.update(dir.id, { status: 'evaluated', outcomeDetail: { before: before ?? null, reason: 'self_reported' } });
        n++;
        continue;
      }
      // An experiment whose quota is still open is not judged before its deadline.
      const deadline = dir.kind === 'experiment' ? (dir.change as { deadline?: string } | null)?.deadline : null;
      if (!dir.verifiedAt && deadline && new Date(deadline).getTime() > this.now().getTime()) continue;
      // FR-016: only a verified change gets worked / no_effect / hurt; otherwise inconclusive (not_verified) with its adherence.
      if (!dir.verifiedAt) {
        await this.d.repo.update(dir.id, {
          status: 'evaluated', outcome: 'inconclusive',
          outcomeDetail: { before: before ?? null, reason: 'not_verified', adherence: dir.verification?.adherence ?? null, verification: vkind },
        });
        n++;
        // Spec 060 FR-005: a directive nobody followed (avoid) or that could not be judged (insight) is a lesson too.
        if (m) await this.rememberUnscored(m.id, dir, dir.verification?.adherence ?? null);
        continue;
      }
      const after = this.metricFor(dg, dir);
      const confounders = await this.d.repo.overlapping(dir);
      let outcome: 'worked' | 'no_effect' | 'hurt' | 'inconclusive' = 'inconclusive';
      let changePct: number | null = null;
      if (dir.expected && before?.value != null && after?.value != null && !after.stale && before.value !== 0 && !confounders) {
        changePct = ((after.value - before.value) / Math.abs(before.value)) * 100;
        const signed = dir.expected.direction === 'up' ? changePct : -changePct;
        outcome = signed >= dir.expected.min_change_pct ? 'worked' : signed <= -dir.expected.min_change_pct ? 'hurt' : 'no_effect';
      }
      await this.d.repo.update(dir.id, { status: 'evaluated', outcome, outcomeDetail: { before: before ?? null, after, changePct, confounders } });
      n++;
      if (m && outcome === 'inconclusive') await this.rememberUnscored(m.id, dir, dir.verification?.adherence ?? null);
      if (m && (outcome === 'worked' || outcome === 'hurt')) {
        await this.d.repo.addMemory(m.id, 'insight',
          `${dir.kind} для @${this.handleCache.get(dir.toAgentId) ?? '?'} (${dir.body.slice(0, 120)}) — ${outcome === 'worked' ? 'спрацювало' : 'зашкодило'}: ${dir.expected?.metric} ${changePct?.toFixed(0)}%.`,
          { directive: dir.id, changePct }, 'system');
      }
    }
    return n;
  }
}
