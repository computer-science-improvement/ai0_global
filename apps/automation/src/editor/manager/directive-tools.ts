import { z } from 'zod';
import { defineTool, EditorTool, ToolContext } from '../harness/tool';
import type { Agent } from '../agents/agent.types';
import type { AgentsRepository } from '../agents/agents.repository';
import type { OwnerInbox } from '../agents/owner-inbox';
import type { PendingActionsService } from '../agents/pending-actions';
import { proposeCard } from '../agents/builder-tools';
import type { EditorMemoryRepository } from '../repo/editor-memory.repository';
import { DIRECTIVE_KINDS, DIRECTIVE_STATUSES, DirectiveKind, DirectivesRepository, Expected, KPI_METRICS } from './directives.repository';
import type { KpiDigest, KpiDigestService } from './kpi-digest.service';
import { admitDirective, BINDINGS, checkBinding, ESCALATION_WINDOW_MS, metricValue, paramStructural } from './directive-kinds';

export const MAX_DIRECTIVES_PER_RUN = 3;
export const REJECT_COOLDOWN_MS = 48 * 3600_000;
export const REVIEW_DAYS = { min: 3, max: 14 };
const REASON_KINDS = ['owner_rule', 'playbook', 'capability', 'health', 'data'] as const;

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
  params:    z.record(z.string(), z.unknown()).default({}).describe('Напр. {format:"ig_carousel", weight_delta:0.2} або {change_pct:-20} або для cross_promo {source_ref, target_ref, window_days}'),
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
  now?:    () => Date;
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
  const structural = isStructural(i.kind, i.params);
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
    outcomeDetail: { at_filing: atFiling, admission: { basis: admission.basis, ...(admission.detail ?? {}) } },
  });
  if (o.ownerApproved) await d.repo.update(dir.id, { ownerDecision: 'approved' });
  if (status === 'awaiting_owner' && !o.shadow) {
    const expected = i.expected ? `${i.expected.metric} ${i.expected.direction === 'up' ? '↑' : '↓'} ≥ ${i.expected.min_change_pct}%` : '—';
    await d.inbox.post({
      agentId: target.id, kind: 'directive_structural', severity: 'action',
      title: `🧭 @manager → @${target.handle}: ${i.kind} — needs your decision`,
      body: `${i.body}\n\nWhy: ${i.rationale}\nExpected: ${expected}\n\nApply or reject it on the @manager page → Directives.`,
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

  const acceptDirective = defineTool({
    name: 'accept_directive',
    description: 'Прийняти директиву менеджера з конкретним планом (що зміниш і коли). Перелічи id правил власника, з якими вона конфліктує (якщо такі є — прийняти не можна, відхили).',
    kind: 'act', roles: ['orchestrator'],
    input: z.object({
      id: z.string().uuid(), plan: z.string().min(15).max(800),
      conflicting_rule_ids: z.array(z.number().int()).max(10).describe('id правил власника з памʼяті (#N), які суперечать директиві; [] — якщо таких немає. Обовʼязкове поле: переглянь правила перед відповіддю.'),
    }),
    execute: async (i, ctx) => {
      const orch = (ctx.extras?.orchestrator as Agent | undefined) ?? agentOf(ctx);
      const dir = await d.repo.get(i.id);
      if (!dir || !orch || dir.toAgentId !== orch.id || dir.shadow) return { error: 'directive_not_found' };
      if (dir.status !== 'new') return { error: 'not_open', details: dir.status };
      // Spec 023: a pause_series directive is applied with set_series_active; an owner-locked series is the owner's rule.
      const seriesName = dir.kind === 'pause_series' ? String((dir.params as any)?.series ?? (dir.params as any)?.name ?? '') : '';
      if (seriesName && d.seriesLocked && await d.seriesLocked(orch, seriesName)) {
        return { error: 'owner_rule_conflict', details: `серію «${seriesName}» заблокував власник — відхили директиву з reason_kind owner_rule` };
      }
      if (i.conflicting_rule_ids.length) {
        const key = await d.channelKeyOf(orch);
        const rules = key ? await d.memory.listActive(key) : [];
        const owner = rules.filter((m) => m.createdBy === 'owner' && i.conflicting_rule_ids.includes(m.id));
        if (owner.length) return { error: 'owner_rule_conflict', details: `правило власника важливіше: «${owner[0].text}» — відхили директиву з reason_kind owner_rule` };
      }
      await d.repo.update(i.id, { status: 'accepted', resolution: i.plan }, ['new']);
      return { ok: true, note: 'Після завершення прогону директива стане applied, а за review_at код оцінить ефект.' };
    },
  });

  const rejectDirective = defineTool({
    name: 'reject_directive',
    description: 'Відхилити директиву з причиною: owner_rule | playbook | capability | health | data, і поясненням (≥ 20 символів).',
    kind: 'act', roles: ['orchestrator'],
    input: z.object({ id: z.string().uuid(), reason_kind: z.enum(REASON_KINDS), reason: z.string().min(20).max(800) }),
    execute: async (i, ctx) => {
      const orch = (ctx.extras?.orchestrator as Agent | undefined) ?? agentOf(ctx);
      const dir = await d.repo.get(i.id);
      if (!dir || !orch || dir.toAgentId !== orch.id) return { error: 'directive_not_found' };
      if (dir.status !== 'new') return { error: 'not_open', details: dir.status };
      await d.repo.update(i.id, { status: 'rejected', resolution: i.reason, reasonKind: i.reason_kind }, ['new']);
      return { ok: true };
    },
  });

  return [getDigest, listDirectives, fileTool, submitReview, acceptDirective, rejectDirective];
}
