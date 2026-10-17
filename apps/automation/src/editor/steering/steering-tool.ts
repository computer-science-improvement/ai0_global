import { z } from 'zod';
import { defineTool, type EditorTool } from '../harness/tool';
import { chatExtras, NEEDS_CHANGE_REQUEST } from '../agents/builder-tools';
import { refName } from './steering.repository';
import type { SteeringService } from './steering.service';

/**
 * Spec 045 FR-009: @ai0 queues a steering analysis. Nothing changes in the channel: the rules appear on /app/steering and
 * the owner activates them there. It costs one model run, so only on the owner's request.
 */
export function buildSteerChannelTool(d: { steering: Pick<SteeringService, 'createSet'> }): EditorTool {
  return defineTool({
    name: 'steer_channel',
    description: [
      'Запустити steering: код прочитає останні 20 постів чужого публічного каналу-референсу, модель напише правила-напрям для нашого каналу (форма і напрям змісту, ніколи не тексти чи факти референсу).',
      'Нічого не змінює: власник переглядає правила на /app/steering і активує їх сам. Правила власника й налаштування каналу завжди важливіші. Коштує один запуск моделі — лише коли власник просить.',
    ].join(' '),
    kind: 'act', roles: ['builder'], chatOnly: true,
    input: z.object({
      channel:   z.string().trim().min(2).max(200).describe('Наш Telegram-канал, напр. @my_channel'),
      reference: z.string().trim().min(2).max(300).describe('Чужий публічний канал: @username або посилання t.me/…'),
    }),
    execute: async (i, ctx) => {
      const x = chatExtras(ctx);
      if (!x.agentIntent) return NEEDS_CHANGE_REQUEST;
      const r = await d.steering.createSet({ target: i.channel, source: i.reference }, 'builder');
      if (!r.ok) return { error: r.error, details: r.details, ...(r.set ? { set_id: r.set.id, link: `/app/steering?set=${r.set.id}` } : {}) };
      return {
        ok: true, set_id: r.set.id, status: r.set.status, link: `/app/steering?set=${r.set.id}`,
        note: `Аналіз ${refName(r.set.sourceRef)} почнеться протягом хвилини. Правила зʼявляться на /app/steering — власник перегляне їх і активує.`,
      };
    },
  });
}
