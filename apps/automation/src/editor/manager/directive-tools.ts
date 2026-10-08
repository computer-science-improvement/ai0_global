import { z } from 'zod';
import { defineTool, EditorTool, ToolContext } from '../harness/tool';
import type { Agent } from '../agents/agent.types';
import type { AgentsRepository } from '../agents/agents.repository';
import type { OwnerInbox } from '../agents/owner-inbox';
import type { PendingActionsService } from '../agents/pending-actions';
import { proposeCard } from '../agents/builder-tools';
import type { EditorMemoryRepository } from '../repo/editor-memory.repository';
import { DIRECTIVE_KINDS, DIRECTIVE_STATUSES, Directive, DirectiveKind, DirectivesRepository, Expected, KPI_METRICS } from './directives.repository';
import type { KpiDigest, KpiDigestService } from './kpi-digest.service';
import { admitDirective, BINDINGS, checkBinding, ESCALATION_WINDOW_MS, metricValue, paramStructural } from './directive-kinds';
import type { DirectiveExecution } from './executors';
import { describe as describeChange } from './executors/playbook-executors';
import { TASK_REF_TYPES, type TaskRefResult, type TaskRefType } from './executors/task-report';

export const MAX_DIRECTIVES_PER_RUN = 3;
export const REJECT_COOLDOWN_MS = 48 * 3600_000;
export const REVIEW_DAYS = { min: 3, max: 14 };
/** Spec 025 FR-005: why an advice may be declined (any layer, own preference included). */
export const DECLINE_REASON_KINDS = ['owner_rule', 'playbook', 'data', 'capability', 'health', 'preference'] as const;
/** Spec 025 FR-005: a binding directive may only be contested by a higher layer (owner rules, safety). */
export const CONTEST_REASON_KINDS = ['owner_rule', 'safety', 'capability', 'health'] as const;
type ContestReasonKind = typeof CONTEST_REASON_KINDS[number];
/** Which precedence layer a contest cites (shown on the owner's card). */
export const CONTEST_LAYER: Record<ContestReasonKind, string> = {
  owner_rule: '1 · owner rules',
  safety:     '2 · safety (code guards, constitution VIII)',
  capability: '2 · safety (platform capability)',
  health:     '2 · safety (resource health)',
};

/** Structural kinds need the owner (D1); code decides, never the model. Spec 025: the parameter part (see directive-kinds). */
export function isStructural(kind: DirectiveKind, params: Record<string, unknown>): boolean {
  return paramStructural(kind, params);
}

const hasNumber = (v: unknown): boolean =>
  typeof v === 'number' || (!!v && typeof v === 'object' && Object.values(v as object).some(hasNumber));

export const FileDirectiveInput = z.object({
  to:        z.string().min(2).max(40).describe('@handle оркестратора'),
  kind:      z.enum(DIRECTIVE_KINDS),
  binding:   z.enum(BINDINGS).describe('advice — порада (за замовчуванням; оркестратор може відхилити); directive — обовʼязкова команда: лише при anomaly метрики expected або ескалації після відхиленої поради; структурні типи — завжди directive'),
  body:      z.string().min(10).max(800).describe('Що саме змінити — конкретно'),
  params:    z.record(z.string(), z.unknown()).default({}).describe('Напр. {format:"ig_carousel", weight_delta:0.2} або {change_pct:-20} або для cross_promo {source_ref, target_ref, window_days}; experiment {resource_ref?, angle, format?, slots 1–3, within_days 1–7}; strategy {brief?}'),
  rationale: z.string().min(20).max(1200),
  evidence:  z.record(z.string(), z.unknown()).describe('Цифри з дайджесту, на які спирається директива'),
  expected:  z.object({
    metric: z.enum(KPI_METRICS), direction: z.enum(['up', 'down']), min_change_pct: z.number().min(1).max(500),
    resource_ref: z.string().max(200).optional(),
  }).optional(),
  review_in_days: z.number().int().min(REVIEW_DAYS.min).max(REVIEW_DAYS.max).default(7),
});
export type FileDirective = z.infer<typeof FileDirectiveInput>;

export interface DirectiveToolDeps {
  repo:    DirectivesRepository;
  agents:  Pick<AgentsRepository, 'getByHandle' | 'findTop'>;
  digest:  Pick<KpiDigestService, 'build' | 'render'>;
  inbox:   Pick<OwnerInbox, 'post'>;
  memory:  Pick<EditorMemoryRepository, 'listActive'>;
  actions: Pick<PendingActionsService, 'propose'>;
  /** The orchestrator's channel (owner rules live in its memory). */
  channelKeyOf: (agent: Agent) => Promise<string | null>;
  /** Spec 023: is this series owner-locked in the orchestrator's active playbook? (pause_series directives) */
  seriesLocked?: (orch: Agent, name: string) => Promise<boolean>;
  /** Spec 025 FR-004: executor dry-run at filing (not_executable, structural detection); FR-006: the capability check. */
  exec?:   Pick<DirectiveExecution, 'dryRun' | 'executorFor'>;
  /** Spec 025 FR-006 health check: the resources in the orchestrator's scope (anchor + group, usable or not). */
  scopeOf?: (orch: Agent) => Promise<string[]>;
  /** Spec 025 FR-006 health check: ResourceHealthService.usable. */
  usable?: (ref: string) => Promise<boolean>;
  /** Spec 025 FR-015: the reference check of report_directive_done (taskRefCheck). */
  taskRef?: (type: TaskRefType, id: string, orch: Agent, since: Date) => Promise<TaskRefResult>;
  now?:    () => Date;
}

/** The outcome of a contest check (spec 025 FR-006), stored in `verification.contest`. */
export interface ContestCheck { reason_kind: ContestReasonKind; verified: boolean | 'unverified'; detail: string; rule_ids?: number[]; resource_ref?: string; checked_at: string }

/**
 * FR-006: the deterministic contest checks. `owner_rule` — every rule id is an active owner rule of the
 * orchestrator; `health` — the resource is in scope and not usable now; `capability` — the executor's plan()
 * fails now; `safety` — accepted, but `unverified`.
 */
export async function checkContest(
  d: Pick<DirectiveToolDeps, 'memory' | 'channelKeyOf' | 'exec' | 'scopeOf' | 'usable'>,
  dir: Pick<Directive, 'kind' | 'params' | 'toAgentId'>, orch: Agent,
  i: { reason_kind: ContestReasonKind; rule_ids?: number[]; resource_ref?: string }, now: Date,
): Promise<ContestCheck> {
  const base = { reason_kind: i.reason_kind, checked_at: now.toISOString() };
  switch (i.reason_kind) {
    case 'owner_rule': {
      const ids = [...new Set(i.rule_ids ?? [])];
      if (!ids.length) return { ...base, verified: false, detail: 'не вказано rule_ids — назви id правил власника (#N з памʼяті)' };
      const key = await d.channelKeyOf(orch);
      const owner = new Set((key ? await d.memory.listActive(key) : []).filter((m) => m.createdBy === 'owner').map((m) => m.id));
      const unknown = ids.filter((x) => !owner.has(x));
      return unknown.length
        ? { ...base, rule_ids: ids, verified: false, detail: `#${unknown.join(', #')} — не активні правила власника` }
        : { ...base, rule_ids: ids, verified: true, detail: `правила власника #${ids.join(', #')} активні` };
    }
    case 'health': {
      const ref = i.resource_ref?.trim();
      if (!ref) return { ...base, verified: false, detail: 'не вказано resource_ref' };
      const scope = d.scopeOf ? await d.scopeOf(orch) : [];
      if (!scope.includes(ref)) return { ...base, resource_ref: ref, verified: false, detail: `${ref} не в мережі @${orch.handle}` };
      if (!d.usable) return { ...base, resource_ref: ref, verified: false, detail: 'стан ресурсів зараз не перевірити' };
      const ok = await d.usable(ref).catch(() => true);
      return ok
        ? { ...base, resource_ref: ref, verified: false, detail: `${ref} зараз доступний (токен і права в порядку)` }
        : { ...base, resource_ref: ref, verified: true, detail: `${ref} зараз недоступний (health)` };
    }
    case 'capability': {
      if (!d.exec?.executorFor(dir.kind)) return { ...base, verified: false, detail: `для ${dir.kind} можливість не перевіряється кодом` };
      const dry = await d.exec.dryRun(dir, orch);
      return dry && 'error' in dry
        ? { ...base, verified: true, detail: `виконавець не може застосувати: ${dry.details}` }
        : { ...base, verified: false, detail: 'виконавець може застосувати цю зміну зараз' };
    }
    case 'safety':
      return { ...base, verified: 'unverified', detail: 'посилання на безпеку прийнято без перевірки кодом' };
  }
}

const agentOf = (ctx: ToolContext): Agent | null => (ctx.extras?.agent as Agent | null | undefined) ?? null;

/**
 * Validate and store a directive (spec 021 FR-004/FR-005). Shared by the
 * manager's tool and the owner-approved chat card. Returns an error object or
 * the stored directive.
 */
export async function fileDirective(d: DirectiveToolDeps, i: FileDirective, o: { from: Agent | null; runId: string | null; shadow: boolean; ownerApproved?: boolean; digest?: KpiDigest | null }) {
  const now = (d.now ?? (() => new Date()))();
  const target = await d.agents.getByHandle(i.to);
  if (!target || target.kind !== 'orchestrator' || target.parentId) return { error: 'not_an_orchestrator', details: i.to };
  if (o.runId && await d.repo.countForRun(o.runId) >= MAX_DIRECTIVES_PER_RUN) return { error: 'too_many_directives', details: `не більше ${MAX_DIRECTIVES_PER_RUN} за прогін` };
  const open = await d.repo.openFor(target.id, i.kind);
  if (open) return { error: 'directive_open', details: `у @${target.handle} вже є відкрита директива ${i.kind} (${open.status})` };
  const rejected = await d.repo.lastRejected(target.id, i.kind);
  if (rejected && now.getTime() - rejected.getTime() < REJECT_COOLDOWN_MS) return { error: 'cooldown', details: 'після відхиленої директиви такого типу — пауза 48 год' };
  if (!hasNumber(i.evidence)) return { error: 'evidence_required', details: 'evidence має містити цифри з дайджесту' };
  if (i.kind !== 'advice' && i.kind !== 'task' && !i.expected) return { error: 'expected_required', details: 'вкажи expected: метрику, напрям і мінімальну зміну' };
  if (i.expected && o.digest) {
    const ref = i.expected.resource_ref;
    const rows = o.digest.resources.filter((r) => (ref ? r.ref === ref : r.agent === target.handle));
    const stale = rows.length > 0 && rows.every((r) => (r.kpis as any)[i.expected!.metric]?.stale);
    if (stale) return { error: 'stale_metric', details: `${i.expected.metric} без свіжих даних — директиви на ній не даються` };
  }
  // Spec 025 FR-002: the kind × binding matrix (kind-only rules first, structural advice after the dry-run).
  const kindRule = checkBinding(i.kind, i.binding, false);
  if (kindRule) return kindRule;
  // Spec 025 FR-004: the executor's dry-run — impossible directives are never filed; its diff can make it structural.
  const dry = d.exec ? await d.exec.dryRun({ kind: i.kind, params: i.params, toAgentId: target.id, body: i.body }, target) : null;
  if (dry && 'error' in dry) return dry;
  const structural = isStructural(i.kind, i.params) || !!dry?.structural;
  const matrix = checkBinding(i.kind, i.binding, structural);
  if (matrix) return matrix;
  // Spec 025 FR-003: a non-structural binding directive needs an anomaly or an escalation; ≤ 2 open per target.
  let dg = o.digest ?? null;
  if (!dg && i.expected && !o.ownerApproved) { try { dg = await d.digest.build(); } catch { dg = null; } }
  const declined = i.binding === 'directive' && !structural && !o.ownerApproved
    ? await d.repo.lastDeclinedAdvice(target.id, i.kind, new Date(now.getTime() - ESCALATION_WINDOW_MS)) : null;
  const admission = admitDirective({
    binding: i.binding, structural, ownerApproved: !!o.ownerApproved, targetHandle: target.handle, expected: i.expected ?? null, digest: dg,
    declined: declined ? { id: declined.id, expected: declined.expected, filedValue: (declined.outcomeDetail as any)?.at_filing?.value ?? null } : null,
    openBinding: i.binding === 'directive' && !o.ownerApproved ? await d.repo.countOpenBinding(target.id, o.shadow) : 0,
  });
  if ('error' in admission) return admission;
  const atFiling = i.expected ? { metric: i.expected.metric, value: metricValue(dg, target.handle, i.expected.metric, i.expected.resource_ref) } : null;
  const status = structural && !o.ownerApproved ? 'awaiting_owner' : 'new';
  const dir = await d.repo.insert({
    fromAgentId: o.from?.id ?? null, toAgentId: target.id, kind: i.kind, binding: i.binding, structural, body: i.body, params: i.params,
    rationale: i.rationale, evidence: i.evidence, expected: (i.expected ?? null) as Expected | null,
    reviewAt: new Date(now.getTime() + i.review_in_days * 86_400_000), status, runId: o.runId, shadow: o.shadow,
    outcomeDetail: {
      at_filing: atFiling, admission: { basis: admission.basis, ...(admission.detail ?? {}) },
      ...(dry ? { dry_run: { change: describeChange(dry), structural: dry.structural, reasons: dry.reasons } } : {}),
    },
  });
  if (o.ownerApproved) await d.repo.update(dir.id, { ownerDecision: 'approved' });
  if (status === 'awaiting_owner' && !o.shadow) {
    const expected = i.expected ? `${i.expected.metric} ${i.expected.direction === 'up' ? '↑' : '↓'} ≥ ${i.expected.min_change_pct}%` : '—';
    await d.inbox.post({
      agentId: target.id, kind: 'directive_structural', severity: 'action',
      title: `🧭 @manager → @${target.handle}: ${i.kind} — needs your decision`,
      body: `${i.body}\n\nWhy: ${i.rationale}\nExpected: ${expected}${dry ? `\nChange: ${describeChange(dry)}` : ''}\n\nApply or reject it on the @manager page → Directives.`,
      alert: {
        title: `🧭 @manager → @${target.handle}: ${i.kind} — потрібне ваше рішення`,
        body: `${i.body}\n\nЧому: ${i.rationale}\nОчікуємо: ${expected}\n\nЗастосувати / відхилити — на сторінці @manager → Directives.`,
      },
      refType: 'directive', refId: dir.id,
    });
  }
  return { ok: true as const, directive: dir };
}

export function buildDirectiveTools(d: DirectiveToolDeps): EditorTool[] {
  const digestOf = async (ctx: ToolContext): Promise<KpiDigest> => {
    const x = ctx.extras as Record<string, unknown> | undefined;
    if (x?.digest) return x.digest as KpiDigest;
    const dg = await d.digest.build();
    if (x) x.digest = dg;
    return dg;
  };

  const getDigest = defineTool({
    name: 'get_kpi_digest',
    description: 'KPI-дайджест мережі: по кожному ресурсу перегляди на пост, залученість, кількість постів, ріст підписників, переходи, дохід — 7 днів проти 28-денної норми, z і аномалії; плани на сьогодні, бюджет, відкриті директиви й результати минулих.',
    kind: 'read', roles: ['manager'],
    input: z.object({}),
    execute: async (_i, ctx) => JSON.parse(d.digest.render(await digestOf(ctx))),
  });

  const listDirectives = defineTool({
    name: 'list_directives',
    description: 'Директиви (відкриті й нещодавні) з їхнім статусом і результатом; для оркестратора — лише його.',
    kind: 'read', roles: ['manager', 'orchestrator'],
    input: z.object({ status: z.array(z.enum(DIRECTIVE_STATUSES)).optional(), limit: z.number().int().min(1).max(50).default(20) }),
    execute: async ({ status, limit }, ctx) => {
      const me = agentOf(ctx);
      const toAgentId = ctx.role === 'orchestrator' ? (ctx.extras?.orchestrator as Agent | undefined)?.id ?? me?.id ?? null : null;
      const list = (await d.repo.list({ status: status ?? null, toAgentId, limit })).filter((x) => !(toAgentId && x.shadow));
      return {
        directives: list.map((x) => ({
          id: x.id, kind: x.kind, binding: x.binding, status: x.status, body: x.body, rationale: x.rationale, expected: x.expected, outcome: x.outcome,
          resolution: x.resolution, verification: x.verification, adherence: x.verification?.adherence ?? null, created_at: x.createdAt,
        })),
      };
    },
  });

  const fileTool = defineTool({
    name: 'file_directive',
    description: [
      'Дати директиву оркестратору (@handle). Лише коли є підстава в цифрах дайджесту; «продовжуйте» — нормальний результат без директив.',
      'binding: advice (порада, за замовчуванням) — оркестратор може відхилити; directive (обовʼязково) — лише коли метрика expected позначена anomaly в дайджесті або після відхиленої поради, коли метрика пішла ще далі; не більше 2 відкритих директив на агента.',
      'Не більше 3 за прогін; не дублюй відкриту директиву; структурні (cross_promo, pause_resource, strategy, частота ±30%, нова платформа) — завжди directive і підуть власнику на рішення.',
    ].join(' '),
    kind: 'act', roles: ['manager'],
    input: FileDirectiveInput,
    execute: async (i, ctx) => {
      const me = agentOf(ctx);
      // In the owner's chat a directive is a confirmation card; the owner's Apply files it (already approved).
      if (ctx.extras?.chat) {
        return proposeCard(d, ctx, 'file_directive', i as unknown as Record<string, unknown>,
          `Директива @manager → ${i.to}: ${i.kind} — ${i.body.slice(0, 200)}`, me?.id ?? null);
      }
      const r = await fileDirective(d, i, { from: me, runId: ctx.runId, shadow: me?.mode !== 'live', digest: await digestOf(ctx) });
      if ('error' in r) return r;
      return { ok: true, id: r.directive.id, binding: r.directive.binding, status: r.directive.status, structural: r.directive.structural, shadow: r.directive.shadow };
    },
  });

  const submitReview = defineTool({
    name: 'submit_review',
    description: 'Завершити прогін менеджера: verdict continue (усе гаразд, продовжуємо) або directives (дано директиви), короткий підсумок для власника.',
    kind: 'terminal', roles: ['manager'],
    input: z.object({ verdict: z.enum(['continue', 'directives']), summary: z.string().min(5).max(1500), directive_ids: z.array(z.string().uuid()).max(3).default([]) }),
    execute: async (i, ctx) => {
      const dg = (ctx.extras as any)?.digest as KpiDigest | undefined;
      await d.repo.addReview({ runId: ctx.runId, verdict: i.verdict, summary: i.summary, digestHash: dg?.hash ?? null, directiveIds: i.directive_ids });
      return { ok: true };
    },
  });

  // ── orchestrator side ─────────────────────────────────────────────────────

  /** The directive addressed to the calling orchestrator and still open, or an error. */
  const own = async (ctx: ToolContext, id: string): Promise<{ dir: Directive; orch: Agent } | { error: string; details?: string }> => {
    const orch = (ctx.extras?.orchestrator as Agent | undefined) ?? agentOf(ctx);
    const dir = await d.repo.get(id);
    if (!dir || !orch || dir.toAgentId !== orch.id || dir.shadow) return { error: 'directive_not_found' };
    if (dir.status !== 'new') return { error: 'not_open', details: dir.status };
    return { dir, orch };
  };

  const acceptDirective = defineTool({
    name: 'accept_directive',
    description: 'Прийняти директиву чи пораду менеджера з конкретним планом (що зміниш і коли). Перелічи id правил власника, з якими вона конфліктує (якщо такі є — прийняти не можна: директиву оскаржуй через contest_directive, пораду відхиляй через decline_advice).',
    kind: 'act', roles: ['orchestrator'],
    input: z.object({
      id: z.string().uuid(), plan: z.string().min(15).max(800),
      conflicting_rule_ids: z.array(z.number().int()).max(10).describe('id правил власника з памʼяті (#N), які суперечать директиві; [] — якщо таких немає. Обовʼязкове поле: переглянь правила перед відповіддю.'),
    }),
    execute: async (i, ctx) => {
      const o = await own(ctx, i.id);
      if ('error' in o) return o;
      const { dir, orch } = o;
      const how = (kind: 'owner_rule' | 'capability') => (dir.binding === 'advice'
        ? `відхили пораду: decline_advice з reason_kind ${kind}`
        : `оскарж директиву власнику: contest_directive з reason_kind ${kind}${kind === 'owner_rule' ? ' і rule_ids' : ''}`);
      // Spec 023: a pause_series directive is applied with set_series_active; an owner-locked series is the owner's.
      const seriesName = dir.kind === 'pause_series' ? String((dir.params as any)?.series ?? (dir.params as any)?.name ?? '') : '';
      if (seriesName && d.seriesLocked && await d.seriesLocked(orch, seriesName)) {
        return { error: 'owner_rule_conflict', details: `серію «${seriesName}» заблокував власник — ${how('capability')}` };
      }
      if (i.conflicting_rule_ids.length) {
        const key = await d.channelKeyOf(orch);
        const rules = key ? await d.memory.listActive(key) : [];
        const owner = rules.filter((m) => m.createdBy === 'owner' && i.conflicting_rule_ids.includes(m.id));
        if (owner.length) return { error: 'owner_rule_conflict', details: `правило власника важливіше: «${owner[0].text}» (#${owner[0].id}) — ${how('owner_rule')}` };
      }
      await d.repo.update(i.id, { status: 'accepted', resolution: i.plan }, ['new']);
      return { ok: true, note: 'Після прогону код сам застосує зміну (виконавець директиви), потім перевірить, чи план їй відповідає; за review_at — оцінка ефекту.' };
    },
  });

  const declineAdvice = defineTool({
    name: 'decline_advice',
    description: 'Відхилити ПОРАДУ менеджера (binding advice) з причиною: owner_rule | playbook | data | capability | health | preference і поясненням (≥ 10 символів). Директиву (binding directive) так не відхилити — її виконують або оскаржують (contest_directive).',
    kind: 'act', roles: ['orchestrator'],
    input: z.object({ id: z.string().uuid(), reason_kind: z.enum(DECLINE_REASON_KINDS), reason: z.string().min(10).max(800) }),
    execute: async (i, ctx) => {
      const o = await own(ctx, i.id);
      if ('error' in o) return o;
      if (o.dir.binding !== 'advice') {
        return { error: 'binding_directive_use_contest', details: 'це ДИРЕКТИВА (обовʼязкова): виконай її (accept_directive) або оскарж власнику (contest_directive) — лише правилом власника чи безпекою' };
      }
      // No Inbox entry and no cooldown (FR-005): the MANAGER sees the reason in its digest.
      const r = await d.repo.update(i.id, { status: 'declined', resolution: i.reason, reasonKind: i.reason_kind }, ['new']);
      return r ? { ok: true, note: 'Порада відхилена; менеджер побачить причину.' } : { error: 'not_open' };
    },
  });

  const contestDirective = defineTool({
    name: 'contest_directive',
    description: [
      'Оскаржити ДИРЕКТИВУ менеджера (binding directive) перед власником — лише вищим шаром:',
      'owner_rule (rule_ids — id активних правил власника #N), safety (код-запобіжники, безпека), capability (платформа чи плейбук не дають застосувати зміну зараз), health (resource_ref зараз недоступний).',
      'Код перевіряє причину; плейбук, дані чи власна думка директиву не скасовують. Власник вирішить: підтримати директиву чи твою відмову.',
    ].join(' '),
    kind: 'act', roles: ['orchestrator'],
    input: z.object({
      id: z.string().uuid(),
      reason_kind: z.enum([...CONTEST_REASON_KINDS, 'playbook', 'data', 'preference']).describe('owner_rule | safety | capability | health'),
      reason: z.string().min(20).max(800),
      rule_ids: z.array(z.number().int()).max(10).optional().describe('Для owner_rule: id правил власника (#N з памʼяті)'),
      resource_ref: z.string().max(200).optional().describe('Для health: ресурс, що зараз недоступний'),
    }),
    execute: async (i, ctx) => {
      const o = await own(ctx, i.id);
      if ('error' in o) return o;
      const { dir, orch } = o;
      if (dir.binding === 'advice') return { error: 'advice_use_decline', details: 'це порада — прийми її (accept_directive) або відхили (decline_advice)' };
      if (!(CONTEST_REASON_KINDS as readonly string[]).includes(i.reason_kind)) {
        return { error: 'directive_is_binding', details: 'директива обовʼязкова: плейбук, дані чи власна думка її не скасовують (директива вища за плейбук). Виконай її (accept_directive) або оскарж правилом власника чи безпекою.' };
      }
      const reasonKind = i.reason_kind as ContestReasonKind;
      const check = await checkContest(d, dir, orch, { reason_kind: reasonKind, rule_ids: i.rule_ids, resource_ref: i.resource_ref }, (d.now ?? (() => new Date()))());
      if (check.verified === false) {
        return { error: 'reason_not_verified', details: `${check.detail} — прийми директиву (accept_directive) або вкажи причину, що справді діє` };
      }
      const row = await d.repo.contest(dir.id, { reason: i.reason, reasonKind, check: { ...check } });
      if (!row) return { error: 'not_open' };
      const layer = CONTEST_LAYER[reasonKind];
      await d.inbox.post({
        agentId: orch.id, kind: 'directive_contested', severity: 'action',
        title: `⚖️ @${orch.handle} contests a directive from @manager: ${dir.kind}`,
        body: [
          `Directive: ${dir.body}`,
          `Refusal (${reasonKind}, precedence layer ${layer}): ${i.reason}`,
          `Check: ${check.verified === true ? `verified — ${check.detail}` : 'unverified (safety reasons are not checked by code)'}`,
          reasonKind === 'owner_rule' ? 'If you uphold the directive, the executor applies it; consider editing the rule.' : '',
          'Uphold the directive or accept the refusal on the @manager page → Directives.',
        ].filter(Boolean).join('\n'),
        alert: {
          title: `⚖️ @${orch.handle} оскаржує директиву @manager: ${dir.kind}`,
          body: `Директива: ${dir.body}\n\nВідмова (${reasonKind}): ${i.reason}\nПеревірка: ${check.verified === true ? check.detail : 'без перевірки кодом'}\n\nПідтримати директиву чи відмову — на сторінці @manager → Directives.`,
        },
        refType: 'directive', refId: dir.id,
      });
      return { ok: true, status: 'contested', note: 'Власник вирішить: підтримати директиву (тоді код її застосує) чи твою відмову.' };
    },
  });

  const reportDone = defineTool({
    name: 'report_directive_done',
    description: 'Повідомити, що завдання менеджера (kind task) виконано: ref_type idea | slot | playbook | skill і ref_id — id того, що ти створив (ідея, слот, версія плейбука, скіл) після отримання завдання. Код перевіряє посилання; тоді завдання — виконане й перевірене.',
    kind: 'act', roles: ['orchestrator'],
    input: z.object({ id: z.string().uuid(), ref_type: z.enum(TASK_REF_TYPES), ref_id: z.string().uuid() }),
    execute: async (i, ctx) => {
      const orch = (ctx.extras?.orchestrator as Agent | undefined) ?? agentOf(ctx);
      const dir = await d.repo.get(i.id);
      if (!dir || !orch || dir.toAgentId !== orch.id || dir.shadow) return { error: 'directive_not_found' };
      if (dir.kind !== 'task') return { error: 'not_a_task', details: `${dir.kind} застосовує код; report_directive_done — лише для task` };
      if (dir.status !== 'new' && dir.status !== 'accepted') return { error: 'not_open', details: dir.status };
      if (!d.taskRef) return { error: 'not_available', details: 'перевірка посилань не підключена' };
      const since = dir.deliveredAt ?? dir.createdAt;
      const r = await d.taskRef(i.ref_type, i.ref_id, orch, since);
      if ('error' in r) return r;
      const now = (d.now ?? (() => new Date()))();
      const row = await d.repo.reportDone(dir.id, { kind: 'reported', adherence: 'followed', ref_type: i.ref_type, ref_id: i.ref_id, ref_at: r.at.toISOString(), checked_at: now.toISOString() });
      return row ? { ok: true, status: row.status, note: 'Завдання виконане й перевірене.' } : { error: 'not_open' };
    },
  });

  return [getDigest, listDirectives, fileTool, submitReview, acceptDirective, declineAdvice, contestDirective, reportDone];
}
