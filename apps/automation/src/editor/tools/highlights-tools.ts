import type { Pool } from 'pg';
import { z } from 'zod';
import { channelOf, defineTool, EditorTool } from '../harness/tool';
import type { EditorCard } from '../card';
import { localDate, zonedToUtc } from '../roles/time';
import { ContentLedger } from '../../data/content-ledger';
import { digestPostsInWindow, pickNetworkHighlights, pickTopicHighlights, postLink } from '../../common/digests/digest-selection';

/**
 * get_network_highlights (spec 023 FR-009): what the legacy network-digest and topic-digest strategies did,
 * as a tool the agent may use or ignore. Same query and the same pick (src/common/digests): without
 * strategy_types the network digest (own channels, ranked by views per hour); with them the topic digest
 * (those post types, the newest N in chronological order). The agent writes the digest post itself.
 */

export interface HighlightsToolDeps {
  pool: Pick<Pool, 'query'>;
  now?: () => Date;
}

export const HighlightsInput = z.object({
  scope:          z.enum(['channel', 'network']).default('network').describe('channel — лише пости цього каналу; network — усі канали мережі'),
  date:           z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Календарний день (час картки); типово — останні 24 год'),
  strategy_types: z.array(z.string().min(2).max(40)).max(10).optional().describe('Лише пости цих типів (напр. ai0-news, ua-news, editor) — тематичний дайджест'),
  min_items:      z.number().int().min(3).max(8).default(3),
  max_items:      z.number().int().min(3).max(8).default(8),
});

export function buildHighlightsTools(d: HighlightsToolDeps): EditorTool[] {
  const now = d.now ?? (() => new Date());

  const getHighlights = defineTool({
    name: 'get_network_highlights',
    description: [
      'Найкраще з уже опублікованих постів мережі для дайджесту: заголовок, посилання t.me, перегляди, час. Без strategy_types — топ за переглядами на годину по всіх каналах мережі; зі strategy_types — тематична добірка (найновіші в хронологічному порядку).',
      'Якщо постів менше за min_items — enough: false, дайджест не пиши. Дайджест — лише власні пости з посиланнями всередину мережі; рекламні й попередні дайджести не входять.',
    ].join(' '),
    kind: 'read', roles: ['planner', 'executor', 'composer', 'orchestrator', 'idea_reviewer', 'manager'],
    input: HighlightsInput,
    execute: async (i, ctx) => {
      const card = ctx.extras?.card as EditorCard | undefined;
      const tz = card?.timezone ?? 'Europe/Kyiv';
      const t = now();
      const channel = channelOf(ctx);
      if (i.scope === 'channel' && !channel) return { error: 'no_channel', details: 'scope channel потребує каналу' };
      const day = i.date ?? localDate(t, tz);
      const from = i.date ? zonedToUtc(i.date, '00:00', tz) : undefined;
      const window = from ? { from, to: new Date(from.getTime() + 86_400_000) } : { windowHours: 24 };
      const topic = !!i.strategy_types?.length;
      const rows = await digestPostsInWindow(d.pool, {
        ...window, channels: i.scope === 'channel' ? [channel!] : undefined,
        strategyTypes: i.strategy_types, ownWithViews: !topic, order: topic ? 'oldest' : 'newest',
      });
      const max = Math.max(i.max_items, i.min_items);
      const picked = topic ? pickTopicHighlights(rows, max) : pickNetworkHighlights(rows, from ? new Date(from.getTime() + 86_400_000) : t, max);
      // The legacy strategies mark one digest per channel per day with a digest:// sentinel (posted_news → ledger).
      const digestRef = channel ? `digest://${topic ? 'topic' : 'network'}/${channel}/${day}` : null;
      const already = digestRef ? await new ContentLedger(d.pool).used(channel!, digestRef) : false;
      return {
        scope: i.scope, date: day, total_in_window: rows.length, enough: picked.length >= i.min_items,
        items: picked.map((r) => ({
          channel: r.channelKey, title: r.title, url: postLink(r), views: r.views, posted_at: r.postedAt.toISOString(), type: r.strategyType ?? null,
        })),
        ...(already ? { already_posted_today: true, note: 'дайджест на цю дату вже виходив у цьому каналі' } : {}),
        ...(picked.length < i.min_items ? { note: `лише ${picked.length} постів з посиланням — замало для дайджесту; пропусти або візьми інше джерело` } : {}),
      };
    },
  });

  return [getHighlights];
}
