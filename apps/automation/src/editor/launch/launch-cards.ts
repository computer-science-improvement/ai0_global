import type { Pool } from 'pg';
import type { CardSource, WaitingItem } from '../owner-bot/card-sources';
import { kyivTime } from '../owner-bot/owner-text';
import type { LaunchBotState } from './launch.types';

/**
 * Spec 052 FR-002: the launch in the owner bot (kind `launch`). A ready plan waits for Start (it asks to confirm); a
 * Start waiting for the bot asks the owner to make the bot an administrator, with "Перевірити" to check now. The text is
 * the owner's Telegram text (Ukrainian); the buttons call the same service methods as the dashboard.
 */

export interface LaunchCardDeps {
  pool:     Pick<Pool, 'query'>;
  launches: {
    start(id: string): Promise<{ started: boolean; waitingFor: string | null }>;
    check(id: string): Promise<{ launch: { status: string; channelKey: string; bot: LaunchBotState | null } }>;
  };
}

export const launchPath = (id: string) => `/app/artifacts?type=launch&open=launch:${id}`;
const at = (outcome: string) => `${outcome} · ${kyivTime(new Date())}`;

/** The bot's state in one Ukrainian line. */
export function botLineUk(key: string, b: LaunchBotState | null): string {
  const bot = b?.bot ?? 'бот';
  if (!b) return `Перевіряю, чи ${bot} — адміністратор ${key}.`;
  if (b.state === 'ok') return `${bot} — адміністратор ${key}.`;
  if (b.state === 'no_access') return `Додайте ${bot} в ${key} адміністратором із правом публікувати повідомлення.`;
  if (b.state === 'token_invalid') return `Токен бота недійсний — перевірте Settings → Telegram.`;
  return `Не вдалося перевірити ${bot}: Telegram не відповів, спробую ще раз.`;
}

export function launchSource(d: LaunchCardDeps): CardSource {
  return {
    kind: 'launch', emoji: '🚀', label: 'Запуск каналу',
    async waiting() {
      const { rows } = await d.pool.query(
        `SELECT id, channel_key, plan->>'summary' AS summary, start_requested, bot_state, updated_at
           FROM channel_launches WHERE status = 'ready' ORDER BY updated_at`);
      return rows.map((r: any): WaitingItem => {
        const bot = (r.bot_state && Object.keys(r.bot_state).length ? r.bot_state : null) as LaunchBotState | null;
        const botOk = bot?.state === 'ok';
        if (r.start_requested && !botOk) {
          return {
            refId: `${r.id}:bot`, title: `${r.channel_key}: чекаю бота`,
            body: `${botLineUk(r.channel_key, bot)} Запуск стартує сам, щойно бот стане адміністратором.`,
            path: launchPath(r.id), critical: false, since: new Date(r.updated_at),
            buttons: [{ key: 'check', label: 'Перевірити' }, { key: 'open', label: 'Відкрити' }],
          };
        }
        return {
          refId: `${r.id}:start`, title: `${r.channel_key}: план запуску готовий`,
          body: [r.summary ? String(r.summary).slice(0, 600) : null, botLineUk(r.channel_key, bot),
            'Старт застосує план і переведе канал у режим схвалення: пости чекатимуть вашого «так».'].filter(Boolean).join('\n\n'),
          path: launchPath(r.id), critical: false, since: new Date(r.updated_at),
          buttons: [
            { key: 'start', label: 'Старт', confirm: 'Так, запустити' },
            ...(botOk ? [] : [{ key: 'check', label: 'Перевірити бота' }]),
            { key: 'open', label: 'Відкрити' },
          ],
        };
      });
    },
    async act(refId, key) {
      const id = refId.split(':')[0];
      if (key === 'start') {
        const r = await d.launches.start(id);
        return at(r.started ? '✅ Запущено: пости чекають вашого схвалення' : '⏳ Старт прийнято: запущу, щойно бот стане адміністратором');
      }
      if (key === 'check') {
        const { launch } = await d.launches.check(id);
        if (launch.status === 'running') return at('✅ Бот — адміністратор, запуск стартував');
        if (launch.bot?.state === 'ok') return at('✅ Бот — адміністратор');
        throw new Error(botLineUk(launch.channelKey, launch.bot));
      }
      throw new Error(`unknown button ${key}`);
    },
  };
}
