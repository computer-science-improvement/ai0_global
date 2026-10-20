import { z } from 'zod';
import { defineTool, type EditorTool } from '../harness/tool';
import { chatExtras, NEEDS_CHANGE_REQUEST } from '../agents/builder-tools';
import type { LaunchService } from './launch.service';

/**
 * Spec 052 FR-001: @ai0 launches a new channel from the owner's brief and up to 3 reference channels. Nothing goes out:
 * the card and the agent stay `off` until the owner presses Start on the launch (an artifact: its chip in the chat, or
 * /app/artifacts). It costs one model run (plus one per reference), so only on the owner's request.
 */
export function buildLaunchChannelTool(d: { launches: Pick<LaunchService, 'createLaunch'> }): EditorTool {
  return defineTool({
    name: 'launch_channel',
    description: [
      'Запустити НОВИЙ канал (порожній або майже): код створить картку й агента (вимкнені до Start), прочитає 1–3 чужі канали-референси як steering і зробить план запуску — профіль, бриф, формати, рубрики, розклад, голос, ідеї першого тижня.',
      'Власник бачить план і чекліст (додати бота адміном) у картці запуску й натискає Start — тоді канал іде в режим погодження. Для каналу з історією постів — analyze_channel_history. Коштує запуски моделі — лише коли власник просить.',
    ].join(' '),
    kind: 'act', roles: ['builder'], chatOnly: true,
    input: z.object({
      channel:    z.string().trim().min(2).max(200).describe('Новий Telegram-канал, напр. @my_new_channel'),
      references: z.array(z.string().trim().min(2).max(300)).max(3).default([]).describe('0–3 чужі публічні канали, на які власник хоче бути схожим'),
      brief:      z.string().trim().min(30).max(4000).describe('Бриф власника своїми словами: про що канал, для кого, як'),
    }),
    execute: async (i, ctx) => {
      const x = chatExtras(ctx);
      if (!x.agentIntent) return NEEDS_CHANGE_REQUEST;
      const r = await d.launches.createLaunch({ target: i.channel, references: i.references, brief: i.brief }, 'builder');
      const link = (id: string) => `/app/artifacts?type=launch&open=launch:${id}`;
      if (!r.ok) return { error: r.error, details: r.details, ...(r.launch ? { launch_id: r.launch.id, link: link(r.launch.id) } : {}) };
      return {
        ok: true, launch_id: r.launch.id, status: r.launch.status, link: link(r.launch.id),
        note: 'Запуск у черзі: спершу код прочитає референси, потім модель зробить план (кілька хвилин). Власник відкриє картку запуску, додасть бота адміном і натисне Start.',
      };
    },
  });
}
