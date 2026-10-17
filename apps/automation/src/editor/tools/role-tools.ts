import type { Pool } from 'pg';
import { z } from 'zod';
import { channelOf, defineTool, EditorTool, ToolContext } from '../harness/tool';
import { AgentPostSpecSchema, PostSpec } from '../post/post-spec';
import { lintPost } from '../post/lint-post';
import { checkQuizGroundTruth } from '../post/quiz-ground-truth';
import { checkVerbatim, postPlainText } from '../post/verbatim-guard';
import { checkSteeringCopy } from '../steering/steering-guard';
import { renderTelegram } from '../post/render-telegram';
import { htmlToPlain } from '../post/inline-markup';
import { criticGateOf, criticSummary, PUBLISH_TOOL_TIMEOUT_MS } from '../critic/critic-gate';
import { similarity } from '../post/similarity';
import { SubmitPlanInput, validatePlan, type PlanIdea } from '../roles/plan-rules';
import { isQuietHour, localDate, localHour, zonedToUtc } from '../roles/time';
import type { EditorPlansRepository } from '../repo/editor-plans.repository';
import type { EditorMemoryRepository } from '../repo/editor-memory.repository';
import type { EditorChannelsRepository } from '../repo/editor-channels.repository';
import type { SendResult } from '../publish/telegram-editor.publisher';
import type { PreparedPublish } from '../publish/prepare-media';
import { prepareAndRender, publishSpecNow } from '../publish/publish-spec';
import { freshnessDeadline } from '../approval/approval-timing';
import type { CrossPostRequest } from '../publish/editor-crosspost';
import type { TgMessage } from '../post/render-telegram';
import { cardFrom } from './compose-tools';
import type { ScheduleService } from '../schedule/schedule.service';
import type { NetworkCtx } from '../network/network-context';
import type { ExperimentQuota } from '../manager/experiment-quota';
import type { PollCapCtx } from '../roles/poll-cap';
import { NO_FRESH_ITEM } from '../live/live-slot';
import { storyGuard, type StoryGuardResult } from '../story/story-guard';
import type { StoryRegistry } from '../story/story.repository';
import { dryRunOf } from '../roles/preview-run';
import { recentAuditPosts } from '../post/variety/recent-posts';
import { pollCapGuard, slotSeriesOf } from '../post/polls/poll-cap-guard';
import {
  CONFIDENCE_RULE, FormatSample, formatsSummary, KPI_SAMPLE_DAYS, performanceEvidenceCheck, sampleConfidence, weightChangeIssue, WeightChange,
} from '../manager/kpi-confidence';

export const SIMILARITY_LIMIT = 0.6;
/** Spec 037 T2: skip_slot code — a sibling channel already told the story. */
export const STORY_SKIP = 'story_skip';
/** Spec 037 T2: the KPI samples leave native forwards (reposts) out: they are the sibling's post, not ours. */
export const STORY_KPI_SAMPLE_FILTER = `strategy_type IS DISTINCT FROM 'repost'`;
const MAX_MEMORY_ADDS_PER_RUN = 5;

export interface RoleToolDeps {
  pool:      Pool;
  plans:     Pick<EditorPlansRepository,
    'createPlan' | 'reservedSlots' | 'getSlot' | 'updateSlot' | 'countPublishedSince' | 'lastPostAt'
    | 'sourceAlreadyPosted' | 'recentTexts' | 'insertPublication'>;
  memory:    Pick<EditorMemoryRepository, 'listActive' | 'add' | 'retireByReviewer'>;
  channels:  Pick<EditorChannelsRepository, 'setFormatWeights'>;
  publisher: { send(channelKey: string, messages: TgMessage[], opts?: { replyTo?: number }): Promise<SendResult> };
  recordPublish: (channelKey: string) => void;
  notifyPreview?: (channelKey: string, html: string) => Promise<void>;
  /** Live-only media stage for carousel (render + host slides) and longread (Telegraph page). */
  media?: { prepare(spec: PostSpec, key: { channelKey: string; slotId: string }): Promise<PreparedPublish> };
  /** Live-only fan-out to the channel's Meta mirrors; returns warnings, never throws (EditorCrossPoster). */
  crosspost?: { fanOut(r: CrossPostRequest): Promise<string[]> };
  /** Spec 023 FR-004/FR-005: schedule rules in the plan check; blackout and series-source guards on publish. */
  schedule?: Pick<ScheduleService, 'planContext' | 'effectiveCard' | 'publishGuard'>;
  /** Spec 025 FR-014: open experiment quotas of an anchor channel for a plan date. */
  experimentQuotas?: (anchorKey: string, planDate: string, now: Date) => Promise<ExperimentQuota[]>;
  /** Spec 034 FR-005: poll caps and the polls already in the 7-day window (SqlPollCaps.load). */
  pollCaps?: (o: { refs: string[]; planDate: string; tz: string; defaultRef?: string }) => Promise<PollCapCtx>;
  /**
   * Spec 037 FR-013 seam: an SQL predicate over editor_v_post_performance rows that keeps a row in the KPI sample.
   * Spec 037 T2 passes STORY_KPI_SAMPLE_FILTER (reposts are out); T10 adds evergreen.
   */
  kpiSampleFilter?: string;
  /** Spec 037 T2: the story registry — the story guard of publish_post and the record of a stored / sent post. */
  stories?: Pick<StoryRegistry, 'history' | 'record'>;
  now?: () => Date;
}

export interface FormatPerformanceRow extends FormatSample {
  posts:        number;
  median_vph:   number | null;
  avg_forwards: unknown;
}

/**
 * Spec 037 FR-013: per-format performance of the editor's posts over `days` with the sample size `n` (posts with
 * measured views), the median views and the confidence of the sample. `sampleFilter` is the repost/evergreen seam.
 */
export async function loadFormatPerformance(
  pool: Pick<Pool, 'query'>, channelKey: string, days: number, o: { sampleFilter?: string } = {},
): Promise<FormatPerformanceRow[]> {
  const { rows } = await pool.query(
    `SELECT COALESCE(format, 'legacy:' || COALESCE(strategy_type, '?')) AS format, COUNT(*)::int AS posts,
            COUNT(views)::int AS n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY views) AS median_views,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY views_per_hour) AS median_vph,
            ROUND(AVG(forwards)::numeric, 1) AS avg_forwards
       FROM editor_v_post_performance
      WHERE channel_id = $1 AND posted_at >= now() - ($2 || ' days')::interval${o.sampleFilter ? ` AND (${o.sampleFilter})` : ''}
      GROUP BY 1 ORDER BY median_vph DESC NULLS LAST`, [channelKey, days]);
  return rows.map((r) => {
    const n = Number(r.n ?? 0);
    const medianViews = r.median_views == null ? null : Math.round(Number(r.median_views) * 10) / 10;
    return {
      ...r, posts: Number(r.posts ?? 0), n, median_views: medianViews,
      median_vph: r.median_vph == null ? null : Number(r.median_vph),
      confidence: sampleConfidence(n, medianViews),
    };
  });
}

/**
 * Spec 037 FR-013: a direct owner directive lets set_format_weights through the sample guard. Two explicit run
 * signals: the runner marks a run started by an owner command (`extras.ownerDirective === true`), or the call comes
 * from an owner chat turn whose latest message explicitly asks for a change (spec 018 AgentChatExtras: `chat` +
 * `agentIntent` + `ownerText`). A scheduled reviewer run has neither. An owner `rule` in channel memory is cited
 * through the tool's `owner_rule_id` and checked against the memory rows.
 */
export function ownerDirectiveOf(ctx: ToolContext): boolean {
  const x = ctx.extras as { ownerDirective?: unknown; chat?: unknown; agentIntent?: unknown; ownerText?: unknown } | undefined;
  if (x?.ownerDirective === true) return true;
  return !!x?.chat && x.agentIntent === true && typeof x.ownerText === 'string' && x.ownerText.trim().length > 0;
}

function requireSlotCtx(ctx: ToolContext): { channelKey: string; slotId: string } {
  if (!ctx.channelKey || !ctx.slotId) throw new Error('this tool needs a slot context');
  return { channelKey: ctx.channelKey, slotId: ctx.slotId };
}

/**
 * The content-ledger dedup of a post's refs (spec 023 FR-010): published, shadowed, error-marked, or waiting /
 * approved on another slot of the resource (spec 031). Null when the post may go out.
 */
export async function sourceGuard(d: Pick<RoleToolDeps, 'plans'>, channelKey: string, spec: PostSpec) {
  if (spec.library_ref && await d.plans.sourceAlreadyPosted(channelKey, spec.library_ref)) return { error: 'library_item_already_posted' as const };
  if (spec.source && await d.plans.sourceAlreadyPosted(channelKey, spec.source.url)) return { error: 'source_already_posted' as const };
  return null;
}

/** Ordered, deterministic guards for publish_post. Returns an error object or null. */
export async function checkPublishGuards(d: RoleToolDeps, ctx: ToolContext, spec: PostSpec, now: Date) {
  const { channelKey, slotId } = requireSlotCtx(ctx);
  const card = cardFrom(ctx);

  const slot = await d.plans.getSlot(slotId);
  if (!slot || slot.channelKey !== channelKey) return { error: 'slot_not_found' };
  // Spec 034 FR-012: the owner's dry-run Preview runs on a slot that stays `planned`.
  const dry = !!dryRunOf(ctx) && slot.status === 'planned';
  if (slot.status !== 'running' && !dry) return { error: 'slot_not_running', details: `slot status is ${slot.status}` };
  if (card.mode === 'off') return { error: 'channel_off' };

  // Spec 037: the integrity checks resolve dates against the slot time (now for a late slot), in the resource zone.
  const at = slot.scheduledAt && new Date(slot.scheduledAt).getTime() > now.getTime() ? new Date(slot.scheduledAt) : now;
  // Spec 037 T5: the pages and feed items the run read (with their publication dates) feed the freshness checks;
  // T4: their texts (and the library row of library_ref) ground the post's numbers.
  const sources = await criticGateOf(ctx)?.groundingSources(spec);
  // Spec 037 T9: the resource's last 20 posts (monotony) and a fixed slot's topic (same format + topic twice a day).
  const variety = { previous: await recentAuditPosts(d.pool, { channelKey, timezone: card.timezone, excludeSlotId: slotId, card }).catch(() => []), topic: slot.topicMode === 'live' ? undefined : slot.topic };
  const lint = lintPost(spec, card, { id: slotId, channel: channelKey, publishedAt: at.toISOString(), timezone: card.timezone, ctx: { now: now.toISOString(), ...(sources ? { sources } : {}), previous: variety.previous }, topic: variety.topic });
  if (!lint.ok) return { error: 'lint_failed', details: lint.errors };
  const truth = await checkQuizGroundTruth(d.pool, spec);
  if (truth) return truth;
  const verbatim = await checkVerbatim(d.pool, spec);
  if (verbatim) return verbatim;
  // Spec 045 FR-006: nor the text of a reference the channel is steered by.
  const steered = await checkSteeringCopy(d.pool, `telegram:${channelKey}`, `${spec.title ?? ''}\n${postPlainText(spec)}`);
  if (steered) return steered;

  const rendered = renderTelegram(spec, card);
  const corpus = await d.plans.recentTexts(channelKey);
  const maxSim = corpus.reduce((m, t) => Math.max(m, similarity(rendered.preview, t)), 0);
  if (maxSim >= SIMILARITY_LIMIT) return { error: 'too_similar', details: `схожість ${maxSim.toFixed(2)} з нещодавнім постом — інший матеріал або кут` };
  const ref = spec.library_ref ?? spec.source?.url ?? null;
  const dup = await sourceGuard(d, channelKey, spec);
  if (dup) return dup;
  if (d.schedule) {
    const sg = await d.schedule.publishGuard(slot, { libraryRef: spec.library_ref, sourceUrl: spec.source?.url }, { live: card.mode === 'live', now, card, feeds: card.sources });
    if (sg) return sg;
  }
  // Spec 037 T7: polls + quizzes over polls_per_week on what is really out, waiting or approved (live, approval, shadow).
  const polls = await pollCapGuard(d.pool, {
    channelKey, format: spec.format, at, timezone: card.timezone, cap: card.pollsPerWeek, slotId, series: slotSeriesOf(slot),
    playbookSeries: (ctx.extras?.network as NetworkCtx | undefined)?.playbook?.series,
  });
  if (polls) return polls;
  // Spec 037 T2: one story, one post (the resource's 14 days, the network's 24 h); warnings go to the critic.
  let story: Extract<StoryGuardResult, { ok: true }> | null = null;
  if (d.stories) {
    const st = await storyGuard(d.stories, { channelKey, slotId, spec, card, at, now });
    if ('error' in st) return st;
    story = st;
    lint.warnings.push(...st.warnings.map((w) => ({ code: w.code, message: w.message })));
  }

  if (card.mode === 'live') {
    const dayStart = zonedToUtc(localDate(now, card.timezone), '00:00', card.timezone);
    const today = await d.plans.countPublishedSince(channelKey, dayStart);
    if (today >= card.postsPerDayMax) return { error: 'daily_cap_reached', details: `${today}/${card.postsPerDayMax}` };
    if (isQuietHour(localHour(now, card.timezone), card.quietStartHour, card.quietEndHour)) return { error: 'quiet_hours' };
    const last = await d.plans.lastPostAt(channelKey);
    if (last && now.getTime() - last.getTime() < card.minGapMinutes * 60_000) {
      return { error: 'min_gap', details: `останній пост ${Math.round((now.getTime() - last.getTime()) / 60_000)} хв тому, мінімум ${card.minGapMinutes}` };
    }
  }
  return { ok: true as const, rendered, ref, lint, at, story };
}

/** The pool ideas a single-channel plan names (spec 040 FR-005); a failing read leaves them out (the slot then needs a topic). */
async function planIdeas(pool: Pick<Pool, 'query'> | undefined, ids: string[]): Promise<Map<string, PlanIdea>> {
  if (!pool || !ids.length) return new Map();
  try {
    const { rows } = await pool.query(`SELECT id, title, angle, sources FROM content_ideas WHERE id = ANY($1::uuid[])`, [[...new Set(ids)]]);
    return new Map(rows.map((r: any) => [r.id, { title: r.title, angle: r.angle ?? null, sources: r.sources ?? [] }]));
  } catch {
    return new Map();
  }
}

export function buildRoleTools(d: RoleToolDeps): EditorTool[] {
  const now = d.now ?? (() => new Date());
  const memoryAdds = new Map<string, number>();

  // ── planner ───────────────────────────────────────────────────────────────
  const submitPlan = defineTool({
    name: 'submit_plan',
    description: 'Зберегти план на день плану (сьогодні; у режимі апруву ввечері — завтра) (завершує роботу). Код перевіряє кількість, час, тихі години, інтервали, формати, частку експериментів, експерименти за директивою (directive_id), серії за розкладом (slot.series або skipped_series з причиною) і правила власника (закріплені пости, заборонені вікна, частота) — при помилці виправ і надішли знову.',
    kind: 'terminal', roles: ['planner'], repeatError: 'same_plan_rejected', placeholdersAbsent: true,
    input: SubmitPlanInput,
    execute: async (plan, ctx) => {
      const card = cardFrom(ctx);
      const t = now();
      const planDate = (ctx.extras?.planDate as string) ?? localDate(t, card.timezone);
      const dayStart = zonedToUtc(planDate, '00:00', card.timezone);
      const reserved = await d.plans.reservedSlots(card.channelKey, dayStart, new Date(dayStart.getTime() + 86_400_000));
      const sched = d.schedule ? await d.schedule.planContext(card, (ctx.extras?.network as NetworkCtx | undefined) ?? null, planDate, t, 'single') : undefined;
      // Spec 025 FR-014: a single-channel plan carries the quotas on its own channel only.
      const anchor = `telegram:${card.channelKey}`;
      const quotas = d.experimentQuotas ? (await d.experimentQuotas(card.channelKey, planDate, t)).filter((q) => q.resourceRef === anchor) : [];
      const pollCap = d.pollCaps ? await d.pollCaps({ refs: [anchor], planDate, tz: card.timezone, defaultRef: anchor }) : undefined;
      const ideas = await planIdeas(d.pool, plan.slots.map((s) => s.idea_id).filter((x): x is string => !!x));
      const v = validatePlan(plan, sched ? d.schedule!.effectiveCard(card, sched) : card, planDate, t, reserved.map((r) => r.scheduledAt), sched, quotas, pollCap, ideas);
      if (!v.ok) return { error: 'plan_invalid', details: v.errors };
      const planId = await d.plans.createPlan(card.channelKey, planDate, plan.rationale, ctx.runId, v.slots);
      // Pool ideas taken into the plan (spec 020) leave the pool; they become `used` once their slots are done.
      const ideaIds = [...new Set(v.slots.map((s) => s.ideaId).filter(Boolean))];
      if (ideaIds.length) {
        await d.pool.query(`UPDATE content_ideas SET status = 'planned', updated_at = now() WHERE id = ANY($1::uuid[]) AND status = 'accepted'`, [ideaIds]).catch(() => {});
      }
      return { ok: true, plan_id: planId, slots: v.slots.length };
    },
  });

  // ── executor ──────────────────────────────────────────────────────────────
  const publishPost = defineTool({
    name: 'publish_post',
    description: 'Опублікувати PostSpec у слот (завершує роботу). Перед збереженням пост читає критик: critic_revise — виправ зауваження й виклич ще раз (одна спроба). У shadow-режимі пост зберігається як превʼю без публікації; у режимі апруву — повністю готується і чекає схвалення власника. Перед цим обовʼязково lint_post.',
    kind: 'terminal', roles: ['executor'], timeoutMs: PUBLISH_TOOL_TIMEOUT_MS,
    input: z.object({ spec: AgentPostSpecSchema }),
    execute: async ({ spec }, ctx) => {
      const t = now();
      const g = await checkPublishGuards(d, ctx, spec, t);
      if ('error' in g) return g;
      const { channelKey, slotId } = requireSlotCtx(ctx);
      const card = cardFrom(ctx);
      // Spec 037 T2: the stored / sent post joins its story (best-effort: the post is already stored or out).
      const recordStory = async (p: { publishedPostId?: number; messageId?: number } = {}) => {
        if (!d.stories || !g.story) return;
        const s = spec.story;
        await d.stories.record({
          channelKey, slotId, ...p, postedAt: g.at, title: spec.title, post: g.story.post, assessment: g.story.assessment,
          story: s ? { key: s.key, kind: s.kind, newFacts: s.new_facts, decision: s.decision, reason: s.reason } : null,
        }).catch(() => {});
      };

      // Spec 034 FR-004: the critic reads the finished post after every guard, before anything is stored or sent.
      const gate = criticGateOf(ctx);
      let critic: Record<string, unknown> | null = null;
      if (gate) {
        const c = await gate.check({ text: htmlToPlain(g.rendered.preview), spec, format: spec.format, warnings: g.lint.warnings, publishAt: g.at.toISOString(), timezone: card.timezone, story: g.story?.critic ?? null });
        if (c.kind !== 'proceed') return c.result;
        critic = criticSummary(c.critic);
      }
      const withCritic = critic ? { critic } : {};

      const dry = dryRunOf(ctx);

      // Spec 037 T16: the critic takes minutes; another slot of the resource may have published or put up the
      // same source meanwhile (it was not in the ledger or waiting when the guards ran). Ask the ledger again.
      if (gate && !dry) {
        const dup = await sourceGuard(d, channelKey, spec);
        if (dup) return { ...dup, details: 'поки критик читав пост, це джерело вже вийшло або чекає апруву на цьому ресурсі — інший матеріал або skip_slot' };
      }

      // Spec 034 FR-012: a dry-run Preview stops here — nothing is stored on the slot, sent, put up for approval or ledgered.
      if (dry) {
        dry.store({ platform: 'telegram', preview: g.rendered.preview, spec, warnings: g.lint.warnings.map((w) => w.message) });
        return { ok: true, dry: true, warnings: g.lint.warnings, ...withCritic };
      }

      if (card.mode === 'approve') {
        // Spec 031 FR-004: every live check ran above; prepare media and render exactly what will be sent, then wait.
        // Nothing is sent here — only the approval publisher sends, and only a slot with approved_at.
        const prep = await prepareAndRender(d, { channelKey, spec, card, mediaKey: slotId });
        if ('error' in prep) return prep;
        const slot = await d.plans.getSlot(slotId);
        const warnings = g.lint.warnings.map((w) => w.message);
        await d.plans.updateSlot(slotId, {
          status: 'awaiting_approval', postSpec: spec, renderedPreview: prep.rendered.preview,
          renderMessages: { kind: 'telegram', messages: prep.rendered.messages, primary: prep.rendered.primary },
          preparedMedia: prep.prepared, lintWarnings: warnings,
          freshnessDeadline: slot ? freshnessDeadline(slot, card) : null, error: null,
        });
        await recordStory();
        // Hosted slides stay until the post is published (the owner sees them and the publisher sends them).
        return { ok: true, awaiting_approval: true, warnings: g.lint.warnings, ...withCritic };
      }

      if (card.mode !== 'live') {
        await d.plans.updateSlot(slotId, { status: 'shadowed', postSpec: spec, renderedPreview: g.rendered.preview, error: null });
        await recordStory();
        if (d.notifyPreview) {
          try { await d.notifyPreview(channelKey, g.rendered.preview); } catch { /* preview is best-effort */ }
        }
        return { ok: true, shadow: true, warnings: g.lint.warnings, ...withCritic };
      }

      // Live only, after every guard (media stage, send, publication row, mirrors: publishSpecNow).
      const res = await publishSpecNow(d, {
        channelKey, spec, card, sourceRef: g.ref, mediaKey: slotId, slotId, replyTo: g.story?.replyTo ?? null,
        onPublished: async (p) => {
          await d.plans.updateSlot(slotId, {
            status: 'published', publishedPostId: p.postId, postSpec: spec, renderedPreview: p.preview,
            error: p.partialError ? `partial: ${p.partialError}` : null,
          });
          await recordStory({ publishedPostId: p.postId, messageId: p.messageId });
        },
      });
      if ('error' in res) return res;
      if (res.mirrorWarnings.length) {
        const partial = res.partialError ? `partial: ${res.partialError}` : null;
        try {
          await d.plans.updateSlot(slotId, { error: [partial, ...res.mirrorWarnings].filter(Boolean).join(' | ').slice(0, 2000) });
        } catch { /* best-effort note on an already published slot */ }
      }
      return {
        ok: true, shadow: false, message_id: res.messageId,
        ...(res.partialError ? { partial_error: res.partialError } : {}),
        ...(res.fallback ? { fallback: res.fallback } : {}),
        ...(res.mirrorWarnings.length ? { crosspost_warnings: res.mirrorWarnings } : {}),
        ...withCritic,
      };
    },
  });

  const skipSlot = defineTool({
    name: 'skip_slot',
    description: 'Пропустити слот з поясненням (завершує роботу). Краще пропустити, ніж опублікувати слабкий, повторний або неперевірений пост.',
    kind: 'terminal', roles: ['executor'],
    input: z.object({
      reason: z.string().min(5).max(500),
      // Spec 034 FR-010: a live slot with nothing fresh in its source.
      code:   z.enum([NO_FRESH_ITEM, STORY_SKIP]).optional().describe(`${NO_FRESH_ITEM} — у live-слоті немає свіжого неопублікованого матеріалу; ${STORY_SKIP} — історію вже розповів сусідній канал мережі (spec 037 T2)`),
    }),
    execute: async ({ reason, code }, ctx) => {
      const { slotId } = requireSlotCtx(ctx);
      await d.plans.updateSlot(slotId, { status: 'skipped', error: code ? `${code}: ${reason}` : `skipped by agent: ${reason}` });
      return { ok: true, skipped: true, ...(code ? { code } : {}) };
    },
  });

  // ── shared read: memory + format performance ─────────────────────────────
  const getMemory = defineTool({
    name: 'get_channel_memory',
    description: 'Памʼять каналу: правила власника і висновки рецензента (insight / rule / avoid), найсвіжіші першими.',
    kind: 'read', roles: ['planner', 'executor', 'reviewer', 'composer'],
    input: z.object({}),
    execute: async (_i, ctx) => {
      const channelKey = channelOf(ctx);
      if (!channelKey) return { error: 'no_channel' };
      return { memory: await d.memory.listActive(channelKey) };
    },
  });

  const formatPerf = defineTool({
    name: 'get_format_performance',
    description: [
      'Ефективність форматів за N днів (лише пости редактора): posts, n (пости з виміряними переглядами), median_views, median_vph (медіана переглядів/год), avg_forwards',
      `і confidence вибірки (${CONFIDENCE_RULE}).`,
      'Висновок «формат X сильніший» — лише з ok; low — обережно і з n; insufficient — висновків не роби.',
      'Якщо всі формати insufficient, у відповіді summary: insufficient_data — кажи «замало даних для порівняння форматів».',
    ].join(' '),
    kind: 'read', roles: ['planner', 'reviewer'],
    input: z.object({ days: z.number().int().min(1).max(180).default(KPI_SAMPLE_DAYS) }),
    execute: async ({ days }, ctx) => {
      if (!ctx.channelKey) return { error: 'no_channel' };
      const formats = await loadFormatPerformance(d.pool, ctx.channelKey, days, { sampleFilter: d.kpiSampleFilter });
      return { days, formats, ...(formatsSummary(formats) ?? {}) };
    },
  });

  // ── reviewer ──────────────────────────────────────────────────────────────
  const addMemory = defineTool({
    name: 'add_memory',
    description: [
      `Записати висновок у памʼять каналу (до ${MAX_MEMORY_ADDS_PER_RUN} за прогін). Конкретно, з цифрами в evidence.`,
      'Висновок про ефективність (формат / тема / час кращий чи гірший за переглядами, реакціями) — з performance: true',
      'і evidence { n, metric, median_views } з get_format_performance; код відмовить (insufficient_data), якщо вибірка insufficient',
      `(${CONFIDENCE_RULE}).`,
    ].join(' '),
    kind: 'act', roles: ['reviewer'],
    input: z.object({
      kind:        z.enum(['insight', 'avoid']),
      text:        z.string().min(15).max(400),
      performance: z.boolean().optional()
        .describe('true — висновок про ефективність форматів/тем/часу; тоді evidence { n, metric, median_views } обовʼязковий'),
      evidence:    z.record(z.string(), z.unknown()).optional()
        .describe('Для performance: n — постів у вибірці, metric — назва метрики, median_views — медіана переглядів на пост у вибірці'),
    }),
    execute: async (i, ctx) => {
      if (!ctx.channelKey) return { error: 'no_channel' };
      // Spec 037 FR-013: a performance note on an insufficient sample is never stored.
      let evidence: Record<string, unknown> | null = i.evidence ?? null;
      if (i.performance) {
        const check = performanceEvidenceCheck(i.evidence);
        if ('error' in check) return check;
        evidence = { ...i.evidence, performance: true, confidence: check.confidence };
      }
      const used = memoryAdds.get(ctx.runId) ?? 0;
      if (used >= MAX_MEMORY_ADDS_PER_RUN) return { error: 'memory_limit', details: `максимум ${MAX_MEMORY_ADDS_PER_RUN} записів за прогін` };
      memoryAdds.set(ctx.runId, used + 1);
      return { ok: true, id: await d.memory.add(ctx.channelKey, i.kind, i.text, evidence, 'reviewer') };
    },
  });

  const retireMemory = defineTool({
    name: 'retire_memory',
    description: 'Деактивувати застарілий висновок рецензента (правила власника змінювати не можна).',
    kind: 'act', roles: ['reviewer'],
    input: z.object({ id: z.number().int().positive(), reason: z.string().min(5).max(300) }),
    execute: async ({ id }, ctx) => {
      if (!ctx.channelKey) return { error: 'no_channel' };
      const ok = await d.memory.retireByReviewer(ctx.channelKey, id);
      return ok ? { ok: true } : { error: 'not_retirable', details: 'запис не існує, вже неактивний або створений власником' };
    },
  });

  const setWeights = defineTool({
    name: 'set_format_weights',
    description: [
      'Змінити ваги форматів каналу (0.05–1). Лише для форматів, що вже є в картці; міняй плавно, крок ≤ 0.2.',
      'Формат, що не пасує ресурсу, можна прибрати одним кроком (вага 0) лише з причиною в drop_reasons, яка спирається на докази:',
      'правки чи відхилення власника або зауваження критика. Підвищення — завжди ±0.2.',
      `Інші зміни спираються на цифри формату: якщо його вибірка за ${KPI_SAMPLE_DAYS} днів insufficient (get_format_performance: ${CONFIDENCE_RULE}),`,
      'код поверне insufficient_data з цифрами — тоді ваги не міняй. Виняток — пряма вказівка власника: його правило з памʼяті каналу (owner_rule_id).',
    ].join(' '),
    kind: 'act', roles: ['reviewer'],
    input: z.object({
      weights:       z.record(z.string(), z.number().min(0).max(1)),
      drop_reasons:  z.record(z.string(), z.string().trim().min(15).max(300)).optional()
        .describe('Формат → чому він не пасує (докази: правки/відхилення власника, нотатки критика). Лише для ваги 0.'),
      owner_rule_id: z.number().int().positive().optional()
        .describe('id активного правила власника (kind rule, з get_channel_memory), яке прямо вимагає цю зміну ваг — тоді вибірка не перевіряється'),
    }),
    execute: async ({ weights, drop_reasons, owner_rule_id }, ctx) => {
      const card = cardFrom(ctx);
      const drop: string[] = [];
      const changed: WeightChange[] = [];
      for (const [f, w] of Object.entries(weights)) {
        const cur = card.formats[f];
        if (cur === undefined) return { error: 'unknown_format', details: f };
        // Spec 034 FR-007: a drop to 0 in one step needs evidence; increases and other decreases keep the ±0.2 step.
        if (w === 0 && Number(cur) > 0) {
          if (!drop_reasons?.[f]) return { error: 'drop_needs_reason', details: `${f}: вага 0 лише з причиною в drop_reasons (правки чи відхилення власника, нотатки критика)` };
          drop.push(f);
          continue;
        }
        if (Math.abs(w - Number(cur)) > 0.2001) return { error: 'step_too_big', details: `${f}: ${cur} → ${w}, максимум ±0.2 (вага 0 — з drop_reasons)` };
        if (Math.abs(w - Number(cur)) > 1e-9) changed.push({ format: f, from: Number(cur), to: w });
      }
      // Spec 037 FR-013: a raise or a cut (not an evidence-backed drop to 0) relies on the format's own numbers.
      let ownerRule: { id: number; text: string } | null = null;
      if (changed.length && !ownerDirectiveOf(ctx)) {
        if (owner_rule_id != null) {
          const rule = (await d.memory.listActive(card.channelKey)).find((m) => m.id === owner_rule_id);
          const learnt = (rule?.evidence as { source?: unknown } | null | undefined)?.source === 'approval';
          if (!rule || rule.createdBy !== 'owner' || rule.kind !== 'rule' || learnt) {
            return { error: 'owner_rule_not_found', details: `${owner_rule_id}: у памʼяті каналу немає активного правила власника (kind rule) з таким id` };
          }
          ownerRule = { id: rule.id, text: rule.text };
        } else {
          const samples = await loadFormatPerformance(d.pool, card.channelKey, KPI_SAMPLE_DAYS, { sampleFilter: d.kpiSampleFilter });
          const issue = weightChangeIssue(changed, samples, KPI_SAMPLE_DAYS);
          if (issue) return issue;
        }
      }
      const left = Object.keys(card.formats).filter((f) => !drop.includes(f) && Number(card.formats[f]) > 0);
      if (drop.length && !left.length) return { error: 'last_format', details: 'у картці має лишитися хоча б один формат' };
      const formats = await d.channels.setFormatWeights(card.channelKey, weights, drop.length ? { drop } : undefined);
      if (drop.length) {
        for (const f of drop) {
          await d.memory.add(card.channelKey, 'avoid', `Формат ${f} прибрано з каналу: ${drop_reasons![f]}`, { tool: 'set_format_weights', format: f }, 'reviewer').catch(() => {});
        }
      }
      return { ok: true, formats, ...(drop.length ? { dropped: drop } : {}), ...(ownerRule ? { owner_rule: ownerRule } : {}) };
    },
  });

  const finishReview = defineTool({
    name: 'finish_review',
    description: 'Завершити тижневий аналіз підсумком для власника (3–5 речень).',
    kind: 'terminal', roles: ['reviewer'],
    input: z.object({ summary: z.string().min(20).max(1500) }),
    execute: async ({ summary }) => ({ ok: true, summary }),
  });

  return [submitPlan, publishPost, skipSlot, getMemory, formatPerf, addMemory, retireMemory, setWeights, finishReview];
}
