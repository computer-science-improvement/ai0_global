import type { Pool } from 'pg';
import { z } from 'zod';
import { defineTool, type EditorTool, type ToolContext } from '../harness/tool';
import { cardFrom } from '../tools/compose-tools';
import { dryRunOf } from '../roles/preview-run';
import { localDate, zonedToUtc } from '../roles/time';
import { PromoExecutor } from '../promo/promo-executor';
import type { EditorPlansRepository } from '../repo/editor-plans.repository';
import { REPOST_HOURS } from './story-match';
import type { StoryRegistry } from './story.repository';

/**
 * Spec 037 T2: `request_story_repost` — the third answer to a sibling channel's story of the last 24 h (besides
 * skip_slot and own_angle): the executor's slot becomes a native forward of the sibling's post, through the promo
 * executor's forward (spec 022, promo kind `story_repost`; no 14-day promo cooldown — the planner's cooldown is not on
 * this path). Limits: ≤ 1 repost per story per channel, ≤ 2 per channel per day (env EDITOR_STORY_REPOSTS_PER_STORY /
 * EDITOR_STORY_REPOSTS_PER_DAY). The decision and its reason go to the trace (the tool result) and to
 * editor_story_posts (role repost, linked to the sibling's post).
 */

export interface StoryRepostLimits { perStory: number; perDay: number }
export const STORY_REPOST_LIMITS: StoryRepostLimits = { perStory: 1, perDay: 2 };

/** The limits from env (invalid / missing → the defaults). */
export function storyRepostLimits(env: (k: string) => string | undefined): StoryRepostLimits {
  const n = (k: string, d: number) => { const v = Number(env(k)); return Number.isInteger(v) && v >= 0 ? v : d; };
  return { perStory: n('EDITOR_STORY_REPOSTS_PER_STORY', STORY_REPOST_LIMITS.perStory), perDay: n('EDITOR_STORY_REPOSTS_PER_DAY', STORY_REPOST_LIMITS.perDay) };
}

export interface StoryToolDeps {
  pool:     Pick<Pool, 'query'>;
  plans:    Pick<EditorPlansRepository, 'getSlot' | 'updateSlot'>;
  stories:  Pick<StoryRegistry, 'repostSource' | 'repostCounts' | 'recordRepost' | 'recordForward'>;
  /** Bot API forwardMessage into `toKey` from `fromKey`; returns the new message id. Absent → the repost is shadowed. */
  forward?: (toKey: string, fromKey: string, messageId: number) => Promise<number>;
  limits?:  StoryRepostLimits;
  now?:     () => Date;
  log?:     (m: string) => void;
}

function slotCtx(ctx: ToolContext): { channelKey: string; slotId: string } {
  if (!ctx.channelKey || !ctx.slotId) throw new Error('this tool needs a slot context');
  return { channelKey: ctx.channelKey, slotId: ctx.slotId };
}

export function buildStoryTools(d: StoryToolDeps): EditorTool[] {
  const now = d.now ?? (() => new Date());
  const limits = d.limits ?? STORY_REPOST_LIMITS;

  const requestStoryRepost = defineTool({
    name: 'request_story_repost',
    description: [
      'Замість власного поста — репост (нативне пересилання) посту сусіднього каналу мережі з тією ж історією (завершує роботу).',
      'Лише коли сусід опублікував цю історію за останні 24 год (див. «Активні історії»: story_key і source_post_id = telegram:<канал>/<id>).',
      `Ліміти: ≤ ${limits.perStory} репост на історію, ≤ ${limits.perDay} на день. reason — чому репост краще за власний пост чи пропуск.`,
    ].join(' '),
    kind: 'terminal', roles: ['executor'],
    input: z.object({
      story_key:      z.string().min(2).max(80),
      source_post_id: z.string().min(3).max(200).describe('telegram:<channel>/<message id> — пост сусіднього каналу'),
      reason:         z.string().min(5).max(300),
    }),
    execute: async ({ story_key, source_post_id, reason }, ctx) => {
      const { channelKey, slotId } = slotCtx(ctx);
      const card = cardFrom(ctx);
      const t = now();
      const slot = await d.plans.getSlot(slotId);
      if (!slot || slot.channelKey !== channelKey) return { error: 'slot_not_found' };
      const dry = dryRunOf(ctx);
      if (slot.status !== 'running' && !(dry && (slot.status === 'planned' || dry.probe))) return { error: 'slot_not_running', details: `slot status is ${slot.status}` };
      if (card.mode === 'off') return { error: 'channel_off' };
      if (slot.resourceRef && !slot.resourceRef.startsWith('telegram:')) return { error: 'story_repost_telegram_only' };

      const src = await d.stories.repostSource(channelKey, story_key, source_post_id);
      if (!src) {
        return { error: 'story_repost_source_not_found', details: `немає опублікованого посту ${source_post_id} сусіднього каналу в історії ${story_key} — візьми story_key і source_post_id з «Активних історій»` };
      }
      const ageH = (t.getTime() - src.postedAt.getTime()) / 3_600_000;
      if (ageH > REPOST_HOURS) return { error: 'story_repost_stale', details: `пост сусіда вийшов ${Math.round(ageH)} год тому — репост лише в перші ${REPOST_HOURS} год` };
      const dayStart = zonedToUtc(localDate(t, card.timezone), '00:00', card.timezone);
      const counts = await d.stories.repostCounts(channelKey, src.storyId, dayStart);
      if (counts.story >= limits.perStory) return { error: 'story_repost_limit', details: `репост цієї історії вже був (${counts.story}/${limits.perStory}) — skip_slot або власний кут` };
      if (counts.day >= limits.perDay) return { error: 'story_repost_daily_limit', details: `сьогодні вже ${counts.day}/${limits.perDay} репостів — skip_slot або власний кут` };

      const postRef = `telegram:${src.fromKey}/${src.messageId}`;
      const decision = { decision: 'repost' as const, reason, story_key: src.storyKey, source_post_id: postRef };
      if (dry) {
        dry.store({ platform: 'telegram', preview: `↪️ Repost ${src.fromKey}/${src.messageId} into ${channelKey}`, spec: { story_repost: decision }, warnings: [] });
        return { ok: true, dry: true, ...decision };
      }

      const promo = { kind: 'story_repost', post_ref: postRef, story_key: src.storyKey, reason, story_post_id: src.storyPostId };
      await d.pool.query(`UPDATE editor_slots SET promo = $2, format = 'repost', updated_at = now() WHERE id = $1`, [slotId, JSON.stringify(promo)]);
      const at = slot.scheduledAt && new Date(slot.scheduledAt).getTime() > t.getTime() ? new Date(slot.scheduledAt) : t;
      await d.stories.recordRepost({ channelKey, slotId, source: src, reason, postedAt: at });

      const exec = new PromoExecutor({
        plans: d.plans, card: async () => card, mode: async () => card.mode,
        catalog: { list: async () => [] }, profiles: { get: async () => null },
        runExecutor: async () => { throw new Error('a story repost has no executor run'); },
        ...(d.forward ? { forward: d.forward } : {}),
        onForwarded: async (s, fromKey, fromMessageId, messageId) => { await d.stories.recordForward({ channelKey: s.channelKey, slotId: s.id, fromKey, fromMessageId, messageId }); },
        log: d.log,
      });
      const fresh = await d.plans.getSlot(slotId);
      const ok = await exec.publishPromo({ ...(fresh ?? slot), promo }, t);
      const after = await d.plans.getSlot(slotId);
      if (!ok) return { error: 'story_repost_failed', details: after?.error ?? 'forward failed' };
      return { ok: true, status: after?.status ?? null, ...decision };
    },
  });

  return [requestStoryRepost];
}
