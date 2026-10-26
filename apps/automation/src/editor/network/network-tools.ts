import { z } from 'zod';
import { isEvergreenTopic, RECENT_TOPIC_DAYS, recentTopicHit, recentTopicsOf } from '../story/recent-topics';
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
import { longText, longTextNote } from '../harness/clip-text';
import type { ExperimentQuota } from '../manager/experiment-quota';
import type { PollCapCtx } from '../roles/poll-cap';
import type { AgentsRepository } from '../agents/agents.repository';
import { planTimePreflightErrors } from '../preflight/plan-time';
import type { SlotPreflight } from '../preflight/slot-preflight';

export const IDEA_DEDUP_SIMILARITY = 0.6;
export const IDEA_MAX_DAYS = 7;
export const AVOID_AFTER_REJECTIONS = 3;
/** Spec 040 FR-004: successful add_idea calls in one run, and the backlog of `new` ideas that stops adding. */
export const MAX_IDEAS_PER_RUN = 12;
export const MAX_NEW_IDEAS = 30;
/** Spec 040 FR-004: list_ideas page size (compact rows stay far below the tool-output cut). */
export const IDEA_PAGE_MAX = 50;
/** Spec 040 FR-004: the reviewer's batch in its prompt, and the longest kept summary. */
export const REVIEW_BATCH = 15;
/** Spec 046 FR-007: the accepted + new ideas that cover this many days of slots stop the adding. */
export const IDEA_RUNWAY_DAYS = 2;
/** Spec 046 FR-007: distinct source hosts a factual idea for a news resource needs. */
export const NEWS_MIN_SOURCES = 2;

/**
 * Spec 046 FR-007: ideas one orchestrator run may add — a day of slots plus one spare, never past the runway
 * (`slotsPerDay` × IDEA_RUNWAY_DAYS ideas accepted or waiting for review).
 */
export function ideaQuota(slotsPerDay: number, waiting: number): number {
  const slots = Math.max(1, Math.ceil(slotsPerDay));
  return Math.max(0, Math.min(slots + 1, MAX_IDEAS_PER_RUN, slots * IDEA_RUNWAY_DAYS - waiting));
}

/** Spec 046 FR-007: distinct hosts (or raw strings for non-URL sources) of an idea's sources. */
export function sourceHosts(sources: string[]): number {
  return new Set(sources.map((s) => hostOf(s) ?? s.trim().toLowerCase())).size;
}
export const REVIEW_SUMMARY_MAX = 4000;
const REASON_CODES = ['duplicate', 'unverifiable', 'off_topic', 'weak', 'risky', 'platform_mismatch', 'off_playbook'] as const;

const IdeaReviewInput = z.object({
  id:      z.string().uuid(),
  verdict: z.enum(['accept', 'revise', 'reject']),
  scores:  z.object({ fit: z.number().int().min(1).max(5), novelty: z.number().int().min(1).max(5), verifiability: z.number().int().min(1).max(5), platform_fit: z.number().int().min(1).max(5), risk: z.number().int().min(1).max(5) }),
  comment: z.string().min(5).max(600),
  reason_code: z.enum(REASON_CODES).optional(),
});
type IdeaReview = z.infer<typeof IdeaReviewInput>;
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
  /** Spec 025: `directive_lock` on submit_playbook. */
  directiveLock?: SubmitDeps['directiveLock'];
  /** Spec 023 FR-004: owner schedule rules, pins and due series in the plan check. */
  schedule?: Pick<ScheduleService, 'planContext' | 'effectiveNet'>;
  /** Spec 025 FR-014: open experiment quotas of an anchor channel for a plan date. */
  experimentQuotas?: (anchorKey: string, planDate: string, now: Date) => Promise<ExperimentQuota[]>;
  /** Spec 034 FR-005: per-resource poll caps and the polls already in the 7-day window (SqlPollCaps.load). */
  pollCaps?: (o: { refs: string[]; planDate: string; tz: string; defaultRef?: string }) => Promise<PollCapCtx>;
  /** Spec 046 FR-008: get_playbook(handle) for the manager, which has no orchestrator context. */
  agents?: Pick<AgentsRepository, 'getByHandle'>;
  /** Spec 068 FR-007: the cheap pre-flight checks on the slots of a plan. */
  preflight?: Pick<SlotPreflight, 'assessPlanned'>;
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

const hostOf = (url: string | undefined): string | null => {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
};

/** One line of the pool (spec 040 FR-004): enough to pick ideas; list_ideas(ids) gives the full ones. */
const ideaRow = (i: IdeaRow) => ({
  id: i.id, title: i.title.length > 120 ? `${i.title.slice(0, 119)}…` : i.title, status: i.status,
  resources: i.variants.map((v) => `${v.resource_ref}/${v.format}`), source_host: hostOf(i.sources[0]),
  created_at: i.createdAt instanceof Date ? i.createdAt.toISOString() : i.createdAt,
});

interface IdeaRunState { added: number; reviewed: number }

/** Per-run counters of the idea tools; extras is a fresh object for every run. */
function ideaRun(ctx: ToolContext): IdeaRunState {
  const x = ctx.extras as { ideaRun?: IdeaRunState } | undefined;
  if (!x) return { added: 0, reviewed: 0 };
  return (x.ideaRun ??= { added: 0, reviewed: 0 });
}

export function buildNetworkTools(d: NetworkToolDeps): EditorTool[] {
  const now = d.now ?? (() => new Date());

  const getPlaybook = defineTool({
    name: 'get_playbook',
    description: 'Активний плейбук мережі (що, куди, як часто) і чернетка, що чекає власника. Ресурси мережі й доступні формати. Менеджер передає handle оркестратора (лише читання).',
    kind: 'read', roles: ['orchestrator', 'planner', 'idea_reviewer', 'executor', 'manager'],
    input: z.object({ handle: z.string().min(2).max(40).optional().describe('Оркестратор, чий плейбук читати (для менеджера)') }),
    execute: async ({ handle }, ctx) => {
      const own = ctx.extras?.network as NetworkCtx | undefined;
      // Spec 046 FR-008: the manager reads any orchestrator's playbook by handle (it has no network context).
      if (handle && (!own || own.orchestrator.handle !== handle.replace(/^@/, ''))) {
        const orch = d.agents ? await d.agents.getByHandle(handle.replace(/^@/, '').toLowerCase()) : null;
        if (!orch || orch.kind !== 'orchestrator') return { error: 'unknown_orchestrator', details: `@${handle.replace(/^@/, '')} — не оркестратор; список агентів є в get_kpi_digest (agents)` };
        const [active, pending] = await Promise.all([d.repo.activePlaybook(orch.id), d.repo.pendingPlaybook(orch.id)]);
        return {
          orchestrator: `@${orch.handle}`,
          active: active ? { version: active.version, body: active.body } : null,
          pending: pending ? { id: pending.id, version: pending.version, rationale: pending.rationale, review: pending.review } : null,
        };
      }
      if (!own) return { error: 'handle_required', details: 'назви handle оркестратора, чий плейбук прочитати' };
      const net = own;
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
    description: [
      'Пул ідей мережі з фільтром за статусом (new, accepted, needs_revision, planned, used, rejected, expired): компактні рядки сторінками',
      '(offset, total, next_offset). Повні ідеї (кут, джерела, варіанти, рецензія) — list_ideas з ids.',
    ].join(' '),
    kind: 'read', roles: ['orchestrator', 'planner', 'idea_reviewer', 'manager'],
    // Spec 053 FR-003: a page of compact rows is the reviewer's whole input — one page, not a cut one.
    maxResultChars: 16_000,
    input: z.object({
      status: z.array(z.enum(IDEA_STATUSES)).max(7).optional(),
      limit:  z.number().int().min(1).max(IDEA_PAGE_MAX).default(20),
      offset: z.number().int().min(0).default(0),
      oldest_first: z.boolean().default(false).describe('true — від найстаріших (черга рецензії)'),
      ids:    z.array(z.string().uuid()).min(1).max(10).optional().describe('Повні дані цих ідей замість сторінки'),
    }),
    execute: async ({ status, limit, offset, oldest_first, ids }, ctx) => {
      const owner = netOf(ctx).orchestrator.id;
      if (ids) {
        const rows = (await Promise.all(ids.map((id) => d.repo.idea(id)))).filter((i): i is IdeaRow => !!i && i.agentId === owner);
        return { ideas: rows.map(ideaBrief), ...(rows.length < ids.length ? { not_found: ids.filter((id) => !rows.some((r) => r.id === id)) } : {}) };
      }
      const page = await d.repo.pageIdeas(owner, status ?? null, { limit, offset, oldestFirst: oldest_first });
      const next = offset + page.rows.length;
      return { total: page.total, offset, ideas: page.rows.map(ideaRow), ...(next < page.total ? { next_offset: next } : {}) };
    },
  });

  const validateVariants = (net: NetworkCtx, variants: Array<{ resource_ref: string; format: string }>): string[] => {
    const errs: string[] = [];
    const res = new Map(net.resources.map((r) => [r.ref, r]));
    for (const v of variants) {
      const r = res.get(v.resource_ref);
      if (!r) {
        const off = net.dropped?.find((x) => x.ref === v.resource_ref);
        errs.push(off
          ? `варіант ${v.resource_ref}: ресурс зараз поза мережею (${off.reason === 'paused' ? 'на паузі' : 'недоступний'}) — прибери варіант (є: ${net.resources.map((x) => x.ref).join(', ')})`
          : `варіант ${v.resource_ref}: не ресурс мережі (є: ${net.resources.map((x) => x.ref).join(', ')})`);
        continue;
      }
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
      'Код відхиляє дублікати (схоже вже є в пулі або публікувалось за 14 днів; пояснення, поради й «що таке» — тема за 30 днів), ідеї без джерел, недоступні формати; ідея для новинного ресурсу потребує 2 джерел з різних сайтів. За прогін — не більше квоти з завдання (слоти дня + 1).',
      // Spec 061 FR-002: a reference document (a law) may be cited again with another clause.
      'Довідковий документ (закон) можна цитувати багато разів: у sources пиши посилання з пунктом у фрагменті (…/1306-2001-п#п.1.10) — виконавець вкаже його як source.anchor; той самий пункт двічі не пройде.',
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
      const run = ideaRun(ctx);
      // Spec 046 FR-007: the run's quota (slots + 1, 0 when the pool covers the runway) set by the runner.
      const x = ctx.extras as { ideaQuota?: number; newsRefs?: string[] } | undefined;
      const quota = Math.min(MAX_IDEAS_PER_RUN, x?.ideaQuota ?? MAX_IDEAS_PER_RUN);
      if (run.added >= quota) {
        return {
          error: 'run_quota',
          details: quota === 0
            ? `ідей у пулі вистачає на ${IDEA_RUNWAY_DAYS} дні — сьогодні нових не додавай, переходь до наступного кроку`
            : `за цей прогін уже додано ${run.added} ідей (межа ${quota}: слоти дня + 1) — більше не додавай, переходь до наступного кроку`,
        };
      }
      const waiting = await d.repo.countIdeas(net.orchestrator.id, ['new']);
      if (waiting >= MAX_NEW_IDEAS) {
        return { error: 'pool_full', details: `${waiting} ідей чекають рецензії (межа ${MAX_NEW_IDEAS}) — нових не додавай, доки рецензент їх не розбере` };
      }
      const errs = validateVariants(net, i.variants);
      if (!i.sources.length && i.origin !== 'series' && i.origin !== 'owner') errs.push('потрібні джерела (sources), з яких можна перевірити факти');
      // Spec 046 FR-007: a news resource's idea stands on two independent sources (a sole source the critic rejects kills it).
      const news = (i.origin === 'orchestrator' || i.origin === 'trend') ? i.variants.filter((v) => x?.newsRefs?.includes(v.resource_ref)).map((v) => v.resource_ref) : [];
      if (news.length && i.sources.length && sourceHosts(i.sources) < NEWS_MIN_SOURCES) {
        errs.push(`${[...new Set(news)].join(', ')} — новинний ресурс: потрібні щонайменше ${NEWS_MIN_SOURCES} незалежні джерела (різні сайти), щоб факти можна було звірити`);
      }
      if (errs.length) return { error: 'idea_invalid', details: errs };
      const text = `${i.title} ${i.angle ?? ''}`;
      const open = await d.repo.listIdeas(net.orchestrator.id, ['new', 'accepted', 'needs_revision', 'planned'], 200);
      const dupOpen = open.map((o) => ({ o, s: similarity(text, `${o.title} ${o.angle ?? ''}`) })).sort((a, b) => b.s - a.s)[0];
      if (dupOpen && dupOpen.s >= IDEA_DEDUP_SIMILARITY) {
        return {
          error: 'duplicate_idea', existing: { id: dupOpen.o.id, title: dupOpen.o.title, status: dupOpen.o.status },
          details: `схоже на «${dupOpen.o.title}» (${dupOpen.s.toFixed(2)}): вона вже в пулі — не подавай її знову, використовуй id ${dupOpen.o.id}`,
        };
      }
      const recent = await d.repo.recentExcerpts(net.resources.map((r) => r.ref), 14);
      const dupPost = recent.map((t) => ({ t, s: similarity(text, t) })).sort((a, b) => b.s - a.s)[0];
      if (dupPost && dupPost.s >= IDEA_DEDUP_SIMILARITY) return { error: 'already_published', details: `схоже на нещодавній пост «${dupPost.t.slice(0, 80)}» (${dupPost.s.toFixed(2)})` };
      // Spec 041 FR-004: an evergreen idea on a topic of the variants' resources in the last 30 days.
      if (isEvergreenTopic(i.title, i.angle)) {
        const topics = recentTopicsOf(await d.repo.recentExcerpts([...new Set(i.variants.map((v) => v.resource_ref))], RECENT_TOPIC_DAYS));
        const hit = recentTopicHit({ title: i.title, angle: i.angle }, topics);
        if (hit) return { error: 'recent_topic', details: `ця тема вже була за ${RECENT_TOPIC_DAYS} днів: «${hit.title.slice(0, 100)}» (спільне: ${hit.shared.join(', ')}) — запропонуй іншу тему` };
      }
      const idea = await d.repo.addIdea({
        agentId: net.orchestrator.id, title: i.title, angle: i.angle ?? null, sources: i.sources, variants: i.variants, why: i.why,
        evidence: i.evidence ?? null, origin: i.origin, originRef: i.origin_ref ?? null,
        expiresAt: new Date(now().getTime() + i.expires_in_days * 86_400_000),
      });
      run.added++;
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
    input: z.object({ summary: longText(10, 1500).describe(`Підсумок; ${longTextNote(1500)}`) }),
    execute: async ({ summary }) => ({ ok: true, summary }),
  });

  // ── idea reviewer ─────────────────────────────────────────────────────────

  const reviewOne = async (i: IdeaReview, ctx: ToolContext) => {
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
      ideaRun(ctx).reviewed++;
      if (status === 'rejected' && code && await d.repo.rejectionCount(net.orchestrator.id, code) === AVOID_AFTER_REJECTIONS) {
        await d.memory.add(net.anchorKey, 'avoid',
          `Рецензент ідей 3+ рази за 14 днів відхилив ${REASON_UK[code as keyof typeof REASON_UK] ?? code} — не пропонуй таких.`, { reason_code: code }, 'reviewer');
      }
      return { ok: true as const, status, ...(verdict !== i.verdict ? { overridden: `код змінив вердикт на ${verdict}` } : {}) };
  };

  const reviewIdea = defineTool({
    name: 'review_idea',
    description: [
      'Оцінка ідеї: verdict accept | revise | reject, бали 1–5 (fit, novelty, verifiability, platform_fit, risk — де 5 = безпечно), коментар і reason_code при відмові.',
      'Код відхиляє автоматично при risk ≤ 2 або verifiability ≤ 2 (крім серій і ідей власника).',
    ].join(' '),
    kind: 'act', roles: ['idea_reviewer'],
    input: IdeaReviewInput,
    execute: async (i, ctx) => reviewOne(i, ctx),
  });

  // Spec 053 FR-004: the whole batch in one call — the reviewer paid a step (and a re-sent prompt) per idea.
  const reviewIdeas = defineTool({
    name: 'review_ideas',
    description: [
      `Оцінка пачки ідей одним викликом (до ${REVIEW_BATCH}): для кожної id, verdict accept | revise | reject, бали 1–5 (fit, novelty, verifiability, platform_fit, risk — де 5 = безпечно), коментар і reason_code при відмові.`,
      'Код відхиляє автоматично при risk ≤ 2 або verifiability ≤ 2 (крім серій і ідей власника). Повертає результат по кожній ідеї.',
    ].join(' '),
    kind: 'act', roles: ['idea_reviewer'],
    input: z.object({ reviews: z.array(IdeaReviewInput).min(1).max(REVIEW_BATCH) }),
    execute: async ({ reviews }, ctx) => {
      const results: Array<{ id: string } & Record<string, unknown>> = [];
      for (const r of reviews) results.push({ id: r.id, ...(await reviewOne(r, ctx)) });
      const failed = results.filter((r) => 'error' in r).length;
      return { reviewed: results.length - failed, ...(failed ? { failed } : {}), results };
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
    description: `Завершити рецензію ідей коротким підсумком (скільки прийнято / на доопрацювання / відхилено і чому; до ${REVIEW_SUMMARY_MAX} символів, довше обрізається).`,
    kind: 'terminal', roles: ['idea_reviewer'],
    input: z.object({ summary: z.string().min(5) }),
    execute: async ({ summary }, ctx) => {
      // Spec 040 FR-004: a review run that reviewed nothing while ideas wait is not finished.
      if (ideaRun(ctx).reviewed === 0) {
        const waiting = await d.repo.countIdeas(netOf(ctx).orchestrator.id, ['new']);
        if (waiting > 0) return { error: 'nothing_reviewed', details: `${waiting} нових ідей чекають: спершу review_ideas хоча б для пачки з промпту, потім підсумок` };
      }
      const cut = summary.length > REVIEW_SUMMARY_MAX;
      return { ok: true, summary: cut ? `${summary.slice(0, REVIEW_SUMMARY_MAX - 1)}…` : summary, ...(cut ? { truncated: true } : {}) };
    },
  });

  // ── network planner ───────────────────────────────────────────────────────

  const submitNetworkPlan = defineTool({
    name: 'submit_network_plan',
    description: [
      'Зберегти план мережі на день плану (сьогодні; у режимі апруву ввечері — завтра) (завершує роботу): слоти по всіх ресурсах — resource_ref, час HH:MM (зона ресурсу), формат, тема, idea_id прийнятої ідеї або series.',
      'Для кожної ідеї в плані — рівно одне рішення на кожен ресурс з секцією плейбука: слот з treatment (unique; duplicate чи adapt з from_slot = номер унікального слота-джерела, не раніше за нього — інтервал обираєш ти, 0 теж можна) і reason, або запис у skips з причиною.',
      'Ресурс, що вже на per_day.max, код пропускає сам (cadence). Експеримент за директивою менеджера — слот з directive_id. Код перевіряє частоти, квоти експериментів, тихі години, формати плейбука (для unique) і жорсткі ліміти платформ (для duplicate/adapt).',
      'Якщо для серії чи ресурсу немає з чого писати — скажи це чесно: skipped_series з cause no_material (знижує мінімум ресурсу) або short_days [{resource_ref, cause, reason}] (мінімум ресурсу 0); код запише це як пропущений слот.',
    ].join(' '),
    kind: 'terminal', roles: ['planner'], repeatError: 'same_plan_rejected', placeholdersAbsent: true,
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
      const planned = [...new Set(plan.slots.map((s) => s.idea_id).filter((x): x is string => !!x))];
      const v = validateNetworkPlan(plan, {
        net: sched ? d.schedule!.effectiveNet(net, sched) : net, schedule: sched,
        card, planDate, weekday: localWeekday(dayStart, card.timezone), now: t,
        ideas: new Map(accepted.map((i) => [i.id, i])), reservedAt: reserved.map((r) => r.scheduledAt),
        // Spec 024: decisions repurpose_post or the owner already made for these ideas stay.
        decided: await d.repo.decidedElsewhere(planned),
        experiments: d.experimentQuotas ? await d.experimentQuotas(net.anchorKey, planDate, t) : [],
        pollCap: d.pollCaps ? await d.pollCaps({ refs: net.resources.map((r) => r.ref), planDate, tz: card.timezone }) : undefined,
      });
      if (!v.ok) return { error: 'plan_invalid', details: v.errors };
      // Spec 068 FR-007: a source or row that cannot post is told to the planner now, not found by the executor when the slot is due.
      const sourceErrors = await planTimePreflightErrors(d.preflight, card, v.slots.map((s, i) => ({
        label: `слот ${i + 1} (${s.resourceRef} ${plan.slots[i].time})`,
        slot: {
          channelKey: net.anchorKey, resourceRef: s.resourceRef === `telegram:${net.anchorKey}` ? null : s.resourceRef, format: s.format, sourceHints: s.sourceHints,
          ...(s.topicMode === 'live' ? { topicMode: 'live' as const } : {}), ideaId: s.ideaId, ...(s.treatment ? { treatment: s.treatment } : {}),
        },
      })));
      if (sourceErrors.length) return { error: 'plan_invalid', details: sourceErrors };
      const planId = await d.plans.createNetworkPlan(net.anchorKey, planDate, plan.rationale, ctx.runId, v.slots, v.decisions, net.orchestrator.id, v.empty);
      for (const id of new Set(v.slots.map((s) => s.ideaId).filter(Boolean) as string[])) await d.repo.updateIdea(id, { status: 'planned' });
      return {
        ok: true, plan_id: planId, slots: v.slots.length, ...(v.empty.length ? { empty_day: v.empty.length } : {}),
        decisions: v.decisions.length, auto_skipped: v.decisions.filter((x) => x.decidedBy === 'system').map((x) => `${x.ideaId} → ${x.resourceRef}`),
      };
    },
  });

  return [getPlaybook, submitPlaybook, listIdeas, addIdea, reviseIdea, finishOrchestration, reviewIdea, reviewIdeas, reviewPlaybook, finishIdeaReview, submitNetworkPlan];
}

export { renderPlaybook };
