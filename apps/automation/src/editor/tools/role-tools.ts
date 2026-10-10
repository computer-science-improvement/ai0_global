import type { Pool } from 'pg';
import { z } from 'zod';
import { channelOf, defineTool, EditorTool, ToolContext } from '../harness/tool';
import { AgentPostSpecSchema, PostSpec } from '../post/post-spec';
import { lintPost } from '../post/lint-post';
import { checkQuizGroundTruth } from '../post/quiz-ground-truth';
import { checkVerbatim } from '../post/verbatim-guard';
import { renderTelegram } from '../post/render-telegram';
import { similarity } from '../post/similarity';
import { SubmitPlanInput, validatePlan } from '../roles/plan-rules';
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

export const SIMILARITY_LIMIT = 0.6;
const MAX_MEMORY_ADDS_PER_RUN = 5;

export interface RoleToolDeps {
  pool:      Pool;
  plans:     Pick<EditorPlansRepository,
    'createPlan' | 'reservedSlots' | 'getSlot' | 'updateSlot' | 'countPublishedSince' | 'lastPostAt'
    | 'sourceAlreadyPosted' | 'recentTexts' | 'insertPublication'>;
  memory:    Pick<EditorMemoryRepository, 'listActive' | 'add' | 'retireByReviewer'>;
  channels:  Pick<EditorChannelsRepository, 'setFormatWeights'>;
  publisher: { send(channelKey: string, messages: TgMessage[]): Promise<SendResult> };
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
  now?: () => Date;
}

function requireSlotCtx(ctx: ToolContext): { channelKey: string; slotId: string } {
  if (!ctx.channelKey || !ctx.slotId) throw new Error('this tool needs a slot context');
  return { channelKey: ctx.channelKey, slotId: ctx.slotId };
}

/** Ordered, deterministic guards for publish_post. Returns an error object or null. */
export async function checkPublishGuards(d: RoleToolDeps, ctx: ToolContext, spec: PostSpec, now: Date) {
  const { channelKey, slotId } = requireSlotCtx(ctx);
  const card = cardFrom(ctx);

  const slot = await d.plans.getSlot(slotId);
  if (!slot || slot.channelKey !== channelKey) return { error: 'slot_not_found' };
  if (slot.status !== 'running') return { error: 'slot_not_running', details: `slot status is ${slot.status}` };
  if (card.mode === 'off') return { error: 'channel_off' };

  const lint = lintPost(spec, card);
  if (!lint.ok) return { error: 'lint_failed', details: lint.errors };
  const truth = await checkQuizGroundTruth(d.pool, spec);
  if (truth) return truth;
  const verbatim = await checkVerbatim(d.pool, spec);
  if (verbatim) return verbatim;

  const rendered = renderTelegram(spec, card);
  const corpus = await d.plans.recentTexts(channelKey);
  const maxSim = corpus.reduce((m, t) => Math.max(m, similarity(rendered.preview, t)), 0);
  if (maxSim >= SIMILARITY_LIMIT) return { error: 'too_similar', details: `схожість ${maxSim.toFixed(2)} з нещодавнім постом — інший матеріал або кут` };
  const ref = spec.library_ref ?? spec.source?.url ?? null;
  if (spec.library_ref && await d.plans.sourceAlreadyPosted(channelKey, spec.library_ref)) return { error: 'library_item_already_posted' };
  if (spec.source && await d.plans.sourceAlreadyPosted(channelKey, spec.source.url)) return { error: 'source_already_posted' };
  if (d.schedule) {
    const sg = await d.schedule.publishGuard(slot, { libraryRef: spec.library_ref, sourceUrl: spec.source?.url }, { live: card.mode === 'live', now, card, feeds: card.sources });
    if (sg) return sg;
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
  return { ok: true as const, rendered, ref, lint };
}

export function buildRoleTools(d: RoleToolDeps): EditorTool[] {
  const now = d.now ?? (() => new Date());
  const memoryAdds = new Map<string, number>();

  // ── planner ───────────────────────────────────────────────────────────────
  const submitPlan = defineTool({
    name: 'submit_plan',
    description: 'Зберегти план на сьогодні (завершує роботу). Код перевіряє кількість, час, тихі години, інтервали, формати, частку експериментів, експерименти за директивою (directive_id), серії за розкладом (slot.series або skipped_series з причиною) і правила власника (закріплені пости, заборонені вікна, частота) — при помилці виправ і надішли знову.',
    kind: 'terminal', roles: ['planner'],
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
      const v = validatePlan(plan, sched ? d.schedule!.effectiveCard(card, sched) : card, planDate, t, reserved.map((r) => r.scheduledAt), sched, quotas, pollCap);
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
    description: 'Опублікувати PostSpec у слот (завершує роботу). У shadow-режимі пост зберігається як превʼю без публікації; у режимі апруву — повністю готується і чекає схвалення власника. Перед цим обовʼязково lint_post.',
    kind: 'terminal', roles: ['executor'],
    input: z.object({ spec: AgentPostSpecSchema }),
    execute: async ({ spec }, ctx) => {
      const t = now();
      const g = await checkPublishGuards(d, ctx, spec, t);
      if ('error' in g) return g;
      const { channelKey, slotId } = requireSlotCtx(ctx);
      const card = cardFrom(ctx);

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
        // Hosted slides stay until the post is published (the owner sees them and the publisher sends them).
        return { ok: true, awaiting_approval: true, warnings: g.lint.warnings };
      }

      if (card.mode !== 'live') {
        await d.plans.updateSlot(slotId, { status: 'shadowed', postSpec: spec, renderedPreview: g.rendered.preview, error: null });
        if (d.notifyPreview) {
          try { await d.notifyPreview(channelKey, g.rendered.preview); } catch { /* preview is best-effort */ }
        }
        return { ok: true, shadow: true, warnings: g.lint.warnings };
      }

      // Live only, after every guard (media stage, send, publication row, mirrors: publishSpecNow).
      const res = await publishSpecNow(d, {
        channelKey, spec, card, sourceRef: g.ref, mediaKey: slotId, slotId,
        onPublished: async (p) => {
          await d.plans.updateSlot(slotId, {
            status: 'published', publishedPostId: p.postId, postSpec: spec, renderedPreview: p.preview,
            error: p.partialError ? `partial: ${p.partialError}` : null,
          });
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
      code:   z.enum([NO_FRESH_ITEM]).optional().describe(`${NO_FRESH_ITEM} — у live-слоті немає свіжого неопублікованого матеріалу`),
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
    description: 'Ефективність форматів за N днів: кількість постів і медіана переглядів/год по кожному формату (лише пости редактора).',
    kind: 'read', roles: ['planner', 'reviewer'],
    input: z.object({ days: z.number().int().min(1).max(180).default(30) }),
    execute: async ({ days }, ctx) => {
      if (!ctx.channelKey) return { error: 'no_channel' };
      const { rows } = await d.pool.query(
        `SELECT COALESCE(format, 'legacy:' || COALESCE(strategy_type, '?')) AS format, COUNT(*)::int AS posts,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY views_per_hour) AS median_vph,
                ROUND(AVG(forwards)::numeric, 1) AS avg_forwards
           FROM editor_v_post_performance
          WHERE channel_id = $1 AND posted_at >= now() - ($2 || ' days')::interval
          GROUP BY 1 ORDER BY median_vph DESC NULLS LAST`, [ctx.channelKey, days]);
      return { days, formats: rows.map((r) => ({ ...r, median_vph: r.median_vph == null ? null : Number(r.median_vph) })) };
    },
  });

  // ── reviewer ──────────────────────────────────────────────────────────────
  const addMemory = defineTool({
    name: 'add_memory',
    description: `Записати висновок у памʼять каналу (до ${MAX_MEMORY_ADDS_PER_RUN} за прогін). Конкретно, з цифрами в evidence.`,
    kind: 'act', roles: ['reviewer'],
    input: z.object({
      kind:     z.enum(['insight', 'avoid']),
      text:     z.string().min(15).max(400),
      evidence: z.record(z.string(), z.unknown()).optional(),
    }),
    execute: async (i, ctx) => {
      if (!ctx.channelKey) return { error: 'no_channel' };
      const used = memoryAdds.get(ctx.runId) ?? 0;
      if (used >= MAX_MEMORY_ADDS_PER_RUN) return { error: 'memory_limit', details: `максимум ${MAX_MEMORY_ADDS_PER_RUN} записів за прогін` };
      memoryAdds.set(ctx.runId, used + 1);
      return { ok: true, id: await d.memory.add(ctx.channelKey, i.kind, i.text, i.evidence ?? null, 'reviewer') };
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
    description: 'Змінити ваги форматів каналу (0.05–1). Лише для форматів, що вже є в картці; міняй плавно, крок ≤ 0.2.',
    kind: 'act', roles: ['reviewer'],
    input: z.object({ weights: z.record(z.string(), z.number().min(0).max(1)) }),
    execute: async ({ weights }, ctx) => {
      const card = cardFrom(ctx);
      for (const [f, w] of Object.entries(weights)) {
        const cur = card.formats[f];
        if (cur === undefined) return { error: 'unknown_format', details: f };
        if (Math.abs(w - Number(cur)) > 0.2001) return { error: 'step_too_big', details: `${f}: ${cur} → ${w}, максимум ±0.2` };
      }
      return { ok: true, formats: await d.channels.setFormatWeights(card.channelKey, weights) };
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
