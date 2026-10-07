import { z } from 'zod';
import { defineTool, EditorTool, ToolContext } from '../harness/tool';
import { similarity } from '../post/similarity';
import type { EditorMemoryRepository } from '../repo/editor-memory.repository';
import type { EditorPlansRepository } from '../repo/editor-plans.repository';
import { localDate, localWeekday, zonedToUtc } from '../roles/time';
import type { EditorCard } from '../card';
import { implementedFormats } from '../platform/capabilities';
import type { OwnerInbox } from '../agents/owner-inbox';
import type { NetworkCtx } from './network-context';
import { IDEA_STATUSES, IdeaRow, NetworkRepository } from './network.repository';
import { SubmitNetworkPlanInput, validateNetworkPlan } from './network-plan';
import { PlaybookSchema, renderPlaybook } from './playbook';
import { submitPlaybookVersion, type SubmitDeps } from './series-edit';
import type { ScheduleService } from '../schedule/schedule.service';

export const IDEA_DEDUP_SIMILARITY = 0.6;
export const IDEA_MAX_DAYS = 7;
export const AVOID_AFTER_REJECTIONS = 3;
const REASON_CODES = ['duplicate', 'unverifiable', 'off_topic', 'weak', 'risky', 'platform_mismatch', 'off_playbook'] as const;
const REASON_UK: Record<typeof REASON_CODES[number], string> = {
  duplicate: 'повтори вже опублікованого', unverifiable: 'ідеї без джерел, які можна перевірити', off_topic: 'теми поза профілем ресурсу',
  weak: 'слабкі, загальні ідеї без конкретики', risky: 'ризиковані теми', platform_mismatch: 'формати, що не пасують платформі', off_playbook: 'ідеї поза плейбуком',
};

export interface NetworkToolDeps {
  repo:   NetworkRepository;
  plans:  Pick<EditorPlansRepository, 'reservedSlots' | 'createNetworkPlan'>;
  memory: Pick<EditorMemoryRepository, 'add'>;
  inbox:  Pick<OwnerInbox, 'post'>;
  /** Spec 023: datasets and card feeds a series source may name. */
  sourceCatalog?: SubmitDeps['sourceCatalog'];
  /** Spec 023 FR-004: owner schedule rules, pins and due series in the plan check. */
  schedule?: Pick<ScheduleService, 'planContext' | 'effectiveNet'>;
  now?:   () => Date;
}

function netOf(ctx: ToolContext): NetworkCtx {
  const n = ctx.extras?.network as NetworkCtx | undefined;
  if (!n) throw new Error('network tools need an orchestrator context');
  return n;
}

const ideaBrief = (i: IdeaRow) => ({
  id: i.id, title: i.title, angle: i.angle, status: i.status, origin: i.origin, variants: i.variants, sources: i.sources,
  why: i.why, expires_at: i.expiresAt, revisions: i.revisions, review: i.review,
});

export function buildNetworkTools(d: NetworkToolDeps): EditorTool[] {
  const now = d.now ?? (() => new Date());

  const getPlaybook = defineTool({
    name: 'get_playbook',
    description: 'Активний плейбук мережі (що, куди, як часто) і чернетка, що чекає власника. Ресурси мережі й доступні формати.',
    kind: 'read', roles: ['orchestrator', 'planner', 'idea_reviewer', 'executor', 'manager'],
    input: z.object({}),
    execute: async (_i, ctx) => {
      const net = netOf(ctx);
      const pending = await d.repo.pendingPlaybook(net.orchestrator.id);
      return {
        network: net.groupName, mode: net.mode,
        resources: net.resources.map((r) => ({ ...r, formats: r.platform === 'telegram' ? net.telegramFormats : implementedFormats(r.platform) })),
        active: net.playbook ? { version: net.playbookVersion, body: net.playbook } : null,
        pending: pending ? { id: pending.id, version: pending.version, rationale: pending.rationale, review: pending.review } : null,
      };
    },
  });

  const submitPlaybook = defineTool({
    name: 'submit_playbook',
    description: [
      'Зберегти нову версію плейбука (завершує роботу). Код перевіряє ресурси, формати, частоти, серії й частки тем.',
      'Структурні зміни (ресурси, ролі, набір форматів, частота ±30%, серії, теми, правила) і перша версія — на затвердження власнику; дрібні (ваги, години, хештеги, тон) застосовуються одразу.',
    ].join(' '),
    kind: 'terminal', roles: ['orchestrator'],
    input: z.object({ body: PlaybookSchema, rationale: z.string().min(20).max(2000) }),
    // Spec 023: one submit path with the series tools (series v2 checks, owner locks, mode-aware classification).
    execute: async ({ body, rationale }, ctx) => submitPlaybookVersion(d, netOf(ctx), ctx, body, rationale),
  });

  const listIdeas = defineTool({
    name: 'list_ideas',
    description: 'Пул ідей мережі з фільтром за статусом (new, accepted, needs_revision, planned, used, rejected, expired).',
    kind: 'read', roles: ['orchestrator', 'planner', 'idea_reviewer', 'manager'],
    input: z.object({ status: z.array(z.enum(IDEA_STATUSES)).max(7).optional(), limit: z.number().int().min(1).max(100).default(40) }),
    execute: async ({ status, limit }, ctx) => ({ ideas: (await d.repo.listIdeas(netOf(ctx).orchestrator.id, status ?? null, limit)).map(ideaBrief) }),
  });

  const validateVariants = (net: NetworkCtx, variants: Array<{ resource_ref: string; format: string }>): string[] => {
    const errs: string[] = [];
    const res = new Map(net.resources.map((r) => [r.ref, r]));
    for (const v of variants) {
      const r = res.get(v.resource_ref);
      if (!r) { errs.push(`варіант ${v.resource_ref}: не ресурс мережі`); continue; }
      const sec = net.playbook?.platforms.find((p) => p.resource_ref === v.resource_ref);
      const allowed = sec ? Object.keys(sec.formats).filter((f) => sec.formats[f] > 0) : (r.platform === 'telegram' ? net.telegramFormats : implementedFormats(r.platform));
      if (!allowed.includes(v.format)) errs.push(`варіант ${v.resource_ref}: формат ${v.format} не дозволений (є: ${allowed.join(', ')})`);
    }
    if (new Set(variants.map((v) => v.resource_ref)).size !== variants.length) errs.push('два варіанти на один ресурс');
    return errs;
  };

  const addIdea = defineTool({
    name: 'add_idea',
    description: [
      'Додати ідею в пул: тема, кут, джерела, варіанти під ресурси (resource_ref + нативний формат), чому вона спрацює (з даних).',
      'Код відхиляє дублікати (схоже вже є в пулі або публікувалось за 14 днів), ідеї без джерел, недоступні формати.',
    ].join(' '),
    kind: 'act', roles: ['orchestrator'],
    input: z.object({
      title:      z.string().min(5).max(140),
      angle:      z.string().max(400).optional(),
      sources:    z.array(z.string().min(3).max(500)).max(8).default([]),
      variants:   z.array(z.object({ resource_ref: z.string().min(3).max(200), format: z.string().min(2).max(30), note: z.string().max(300).optional() })).min(1).max(8),
      why:        z.string().min(10).max(600),
      evidence:   z.record(z.string(), z.unknown()).optional(),
      origin:     z.enum(['orchestrator', 'series', 'directive', 'owner', 'trend']).default('orchestrator'),
      origin_ref: z.string().max(200).optional(),
      expires_in_days: z.number().int().min(1).max(IDEA_MAX_DAYS).default(3),
    }),
    execute: async (i, ctx) => {
      const net = netOf(ctx);
      const errs = validateVariants(net, i.variants);
      if (!i.sources.length && i.origin !== 'series' && i.origin !== 'owner') errs.push('потрібні джерела (sources), з яких можна перевірити факти');
      if (errs.length) return { error: 'idea_invalid', details: errs };
      const text = `${i.title} ${i.angle ?? ''}`;
      const open = await d.repo.listIdeas(net.orchestrator.id, ['new', 'accepted', 'needs_revision', 'planned'], 200);
      const dupOpen = open.map((o) => ({ o, s: similarity(text, `${o.title} ${o.angle ?? ''}`) })).sort((a, b) => b.s - a.s)[0];
      if (dupOpen && dupOpen.s >= IDEA_DEDUP_SIMILARITY) return { error: 'duplicate_idea', details: `схоже на «${dupOpen.o.title}» (${dupOpen.s.toFixed(2)}) у пулі` };
      const recent = await d.repo.recentExcerpts(net.resources.map((r) => r.ref), 14);
      const dupPost = recent.map((t) => ({ t, s: similarity(text, t) })).sort((a, b) => b.s - a.s)[0];
      if (dupPost && dupPost.s >= IDEA_DEDUP_SIMILARITY) return { error: 'already_published', details: `схоже на нещодавній пост «${dupPost.t.slice(0, 80)}» (${dupPost.s.toFixed(2)})` };
      const idea = await d.repo.addIdea({
        agentId: net.orchestrator.id, title: i.title, angle: i.angle ?? null, sources: i.sources, variants: i.variants, why: i.why,
        evidence: i.evidence ?? null, origin: i.origin, originRef: i.origin_ref ?? null,
        expiresAt: new Date(now().getTime() + i.expires_in_days * 86_400_000),
      });
      return { ok: true, id: idea.id };
    },
  });

  const reviseIdea = defineTool({
    name: 'revise_idea',
    description: 'Доопрацювати ідею, яку рецензент повернув (needs_revision): уточнити тему, кут, джерела чи варіанти. Лише один раз.',
    kind: 'act', roles: ['orchestrator'],
    input: z.object({
      id: z.string().uuid(), title: z.string().min(5).max(140).optional(), angle: z.string().max(400).optional(),
      sources: z.array(z.string().min(3).max(500)).max(8).optional(),
      variants: z.array(z.object({ resource_ref: z.string(), format: z.string(), note: z.string().max(300).optional() })).min(1).max(8).optional(),
    }),
    execute: async (i, ctx) => {
      const net = netOf(ctx);
      const idea = await d.repo.idea(i.id);
      if (!idea || idea.agentId !== net.orchestrator.id) return { error: 'idea_not_found' };
      if (idea.status !== 'needs_revision') return { error: 'not_in_revision', details: idea.status };
      if (i.variants) { const e = validateVariants(net, i.variants); if (e.length) return { error: 'idea_invalid', details: e }; }
      await d.repo.updateIdea(i.id, { status: 'new', title: i.title, angle: i.angle, sources: i.sources, variants: i.variants, bumpRevision: true });
      return { ok: true };
    },
  });

  const finishOrchestration = defineTool({
    name: 'finish_orchestration',
    description: 'Завершити щоденний прогін оркестратора коротким підсумком (що в пулі, які директиви прийнято/відхилено).',
    kind: 'terminal', roles: ['orchestrator'],
    input: z.object({ summary: z.string().min(10).max(1500) }),
    execute: async ({ summary }) => ({ ok: true, summary }),
  });

  // ── idea reviewer ─────────────────────────────────────────────────────────

  const reviewIdea = defineTool({
    name: 'review_idea',
    description: [
      'Оцінка ідеї: verdict accept | revise | reject, бали 1–5 (fit, novelty, verifiability, platform_fit, risk — де 5 = безпечно), коментар і reason_code при відмові.',
      'Код відхиляє автоматично при risk ≤ 2 або verifiability ≤ 2 (крім серій і ідей власника).',
    ].join(' '),
    kind: 'act', roles: ['idea_reviewer'],
    input: z.object({
      id:      z.string().uuid(),
      verdict: z.enum(['accept', 'revise', 'reject']),
      scores:  z.object({ fit: z.number().int().min(1).max(5), novelty: z.number().int().min(1).max(5), verifiability: z.number().int().min(1).max(5), platform_fit: z.number().int().min(1).max(5), risk: z.number().int().min(1).max(5) }),
      comment: z.string().min(5).max(600),
      reason_code: z.enum(REASON_CODES).optional(),
    }),
    execute: async (i, ctx) => {
      const net = netOf(ctx);
      const idea = await d.repo.idea(i.id);
      if (!idea || idea.agentId !== net.orchestrator.id) return { error: 'idea_not_found' };
      if (idea.status !== 'new') return { error: 'not_reviewable', details: idea.status };
      let verdict = i.verdict;
      let code = i.reason_code ?? null;
      const exempt = idea.origin === 'series' || idea.origin === 'owner';
      if (i.scores.risk <= 2) { verdict = 'reject'; code = code ?? 'risky'; }
      if (i.scores.verifiability <= 2 && !exempt) { verdict = 'reject'; code = code ?? 'unverifiable'; }
      if (verdict === 'revise' && idea.revisions >= 1) { verdict = 'reject'; code = code ?? 'weak'; }
      if (verdict === 'reject' && !code) code = 'weak';
      const status = verdict === 'accept' ? 'accepted' : verdict === 'revise' ? 'needs_revision' : 'rejected';
      const agent = ctx.extras?.agent as { id: string } | undefined;
      await d.repo.updateIdea(i.id, { status, review: { verdict, scores: i.scores, comment: i.comment, reason_code: code }, reviewedBy: agent?.id ?? null });
      if (status === 'rejected' && code && await d.repo.rejectionCount(net.orchestrator.id, code) === AVOID_AFTER_REJECTIONS) {
        await d.memory.add(net.anchorKey, 'avoid',
          `Рецензент ідей 3+ рази за 14 днів відхилив ${REASON_UK[code as keyof typeof REASON_UK] ?? code} — не пропонуй таких.`, { reason_code: code }, 'reviewer');
      }
      return { ok: true, status, ...(verdict !== i.verdict ? { overridden: `код змінив вердикт на ${verdict}` } : {}) };
    },
  });

  const reviewPlaybook = defineTool({
    name: 'review_playbook',
    description: 'Рецензія чернетки плейбука для власника: чи відповідає брифу і профілю, чи реалістичні частоти, ризики. Коротко, по пунктах.',
    kind: 'act', roles: ['idea_reviewer'],
    input: z.object({ verdict: z.enum(['ok', 'concerns']), comments: z.array(z.string().min(5).max(300)).max(10) }),
    execute: async (i, ctx) => {
      const net = netOf(ctx);
      const pending = await d.repo.pendingPlaybook(net.orchestrator.id);
      if (!pending) return { error: 'no_pending_playbook' };
      await d.repo.setPlaybookReview(pending.id, i);
      return { ok: true };
    },
  });

  const finishIdeaReview = defineTool({
    name: 'finish_idea_review',
    description: 'Завершити рецензію ідей підсумком (скільки прийнято / на доопрацювання / відхилено і чому).',
    kind: 'terminal', roles: ['idea_reviewer'],
    input: z.object({ summary: z.string().min(5).max(1000) }),
    execute: async ({ summary }) => ({ ok: true, summary }),
  });

  // ── network planner ───────────────────────────────────────────────────────

  const submitNetworkPlan = defineTool({
    name: 'submit_network_plan',
    description: [
      'Зберегти план мережі на сьогодні (завершує роботу): слоти по всіх ресурсах — resource_ref, час HH:MM, формат, тема, idea_id прийнятої ідеї або series.',
      'Одна ідея → кілька нативних варіантів на різних ресурсах з інтервалом ≥ 90 хв, Telegram (core) — першим. Код перевіряє частоти, інтервали, тихі години, формати плейбука.',
    ].join(' '),
    kind: 'terminal', roles: ['planner'],
    input: SubmitNetworkPlanInput,
    execute: async (plan, ctx) => {
      const net = netOf(ctx);
      const card = ctx.extras?.card as EditorCard;
      const t = now();
      const planDate = (ctx.extras?.planDate as string) ?? localDate(t, card.timezone);
      const dayStart = zonedToUtc(planDate, '00:00', card.timezone);
      const reserved = await d.plans.reservedSlots(net.anchorKey, dayStart, new Date(dayStart.getTime() + 86_400_000));
      const accepted = await d.repo.listIdeas(net.orchestrator.id, ['accepted'], 200);
      const sched = d.schedule ? await d.schedule.planContext(card, net, planDate, t, 'network') : undefined;
      const v = validateNetworkPlan(plan, {
        net: sched ? d.schedule!.effectiveNet(net, sched) : net, schedule: sched,
        card, planDate, weekday: localWeekday(dayStart, card.timezone), now: t,
        ideas: new Map(accepted.map((i) => [i.id, i])), reservedAt: reserved.map((r) => r.scheduledAt),
      });
      if (!v.ok) return { error: 'plan_invalid', details: v.errors };
      const planId = await d.plans.createNetworkPlan(net.anchorKey, planDate, plan.rationale, ctx.runId, v.slots);
      for (const id of new Set(v.slots.map((s) => s.ideaId).filter(Boolean) as string[])) await d.repo.updateIdea(id, { status: 'planned' });
      return { ok: true, plan_id: planId, slots: v.slots.length };
    },
  });

  return [getPlaybook, submitPlaybook, listIdeas, addIdea, reviseIdea, finishOrchestration, reviewIdea, reviewPlaybook, finishIdeaReview, submitNetworkPlan];
}

export { renderPlaybook };
