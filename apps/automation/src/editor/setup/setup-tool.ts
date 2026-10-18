import type { Pool } from 'pg';
import { z } from 'zod';
import { defineTool, type EditorTool } from '../harness/tool';
import { chatExtras, NEEDS_CHANGE_REQUEST } from '../agents/builder-tools';
import { trackedChannel } from './setup-posts';
import type { ChannelSetupRepository } from './setup.repository';

/**
 * Spec 042 FR-007: @ai0 queues a channel's setup from its history. Nothing changes in the channel: the analysis writes a
 * proposal the owner reviews and applies as an artifact (spec 048: its chip in the chat, or /app/artifacts). It costs one model run, so only on the owner's request.
 */
export function buildAnalyzeHistoryTool(d: { pool: Pick<Pool, 'query'>; repo: Pick<ChannelSetupRepository, 'enqueue'> }): EditorTool {
  return defineTool({
    name: 'analyze_channel_history',
    description: [
      'Запустити налаштування каналу з його історії: код прочитає останні 20 постів, модель запропонує бриф, профіль, форматування, мікс форматів, рубрики, розклад, приклади і голос.',
      'Нічого не змінює: власник переглядає пропозицію (картка в чаті або сторінка Artifacts) і застосовує розділи сам. Коштує один запуск моделі — лише коли власник просить.',
    ].join(' '),
    kind: 'act', roles: ['builder'], chatOnly: true,
    input: z.object({ channel_key: z.string().trim().min(2).max(200).describe('Ключ свого Telegram-каналу, напр. @my_channel') }),
    execute: async (i, ctx) => {
      const x = chatExtras(ctx);
      if (!x.agentIntent) return NEEDS_CHANGE_REQUEST;
      const key = i.channel_key.startsWith('@') || i.channel_key.startsWith('-') ? i.channel_key : `@${i.channel_key}`;
      const ch = await trackedChannel(d.pool, key);
      if (!ch || !ch.isMine) return { error: 'not_own_channel', details: `${key} — не твій відстежуваний канал (list_resources покаже підключені)` };
      const p = await d.repo.enqueue(key, 'builder');
      return {
        ok: true, proposal_id: p.id, status: p.status, link: `/app/artifacts?type=setup&open=setup:${p.id}`,
        note: 'Аналіз почнеться протягом хвилини. Пропозиція зʼявиться в чаті й на сторінці Artifacts — власник перегляне її і застосує потрібні розділи.',
      };
    },
  });
}
