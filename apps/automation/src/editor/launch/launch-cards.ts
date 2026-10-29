import type { Pool } from 'pg';
import type { CardSource, WaitingItem } from '../owner-bot/card-sources';
import { clip, kyivTime, plural } from '../owner-bot/owner-text';
import type { LaunchBotState } from './launch.types';
import { graduationLineUk, SNOOZE_DAYS, SNOOZE_MORE_APPROVED, type GraduationStats } from './launch-graduation';

/**
 * Spec 052 FR-002: the launch in the owner bot (kind `launch`). A ready plan waits for Start (it asks to confirm); a
 * Start waiting for the bot asks the owner to make the bot an administrator, with "Перевірити" to check now; a running
 * launch that met the graduation criteria offers Live (FR-003, "Ще ні" snoozes). The text is
 * the owner's Telegram text (Ukrainian); the buttons call the same service methods as the dashboard.
 */

export interface LaunchCardDeps {
  pool:     Pick<Pool, 'query'>;
  launches: {
    start(id: string): Promise<{ started: boolean; waitingFor: string | null }>;
    goLive(id: string): Promise<{ changed: boolean }>;
    notYet(id: string): Promise<unknown>;
    check(id: string): Promise<{ launch: { status: string; channelKey: string; bot: LaunchBotState | null } }>;
  };
  /**
   * Spec 072 FR-010: the channel's open readiness blockers, read from the stored row (null = none, or not known). A Start card
   * with blockers says so and asks «Так, запустити попри блокери»; the card text is fixed when the card is made, so a card made
   * before a blocker appeared does not mention it (the outcome of Start does, A31).
   */
  readiness?: { blockers(channelKey: string): Promise<{ count: number; first: string } | null> };
}

export const launchPath = (id: string) => `/app/artifacts?type=launch&open=launch:${id}`;
const at = (outcome: string) => `${outcome} · ${kyivTime(new Date())}`;

/** The readiness line of a Start card (FR-010). */
export function readinessLineUk(b: { count: number; first: string }): string {
  const first = clip(b.first.trim().replace(/\.+$/, ''), 90);
  return `Готовність: ${b.count} ${plural(b.count, 'блокер', 'блокери', 'блокерів')} — ${first}${first.endsWith('…') ? '' : '.'} Старт можливий, але ці слоти пропустяться.`;
}

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
  /** A31: the open blockers in the stored row of the launch's channel; 0 when unknown (the outcome then says nothing about them). */
  const openBlockers = async (id: string): Promise<number> => {
    if (!d.readiness) return 0;
    try {
      const { rows } = await d.pool.query(`SELECT channel_key FROM channel_launches WHERE id = $1`, [id]);
      return rows[0] ? ((await d.readiness.blockers(rows[0].channel_key))?.count ?? 0) : 0;
    } catch { return 0; }
  };
  return {
    kind: 'launch', emoji: '🚀', label: 'Запуск каналу',
    async waiting() {
      const { rows } = await d.pool.query(
        `SELECT id, channel_key, status, plan->>'summary' AS summary, start_requested, bot_state, graduation, updated_at
           FROM channel_launches
          WHERE status = 'ready'
             OR (status = 'running' AND graduation->>'proposedAt' IS NOT NULL AND graduation->>'decidedAt' IS NULL)
          ORDER BY updated_at`);
      // FR-010: the stored readiness row of each channel with a ready plan (never a recheck); a failed read leaves the card as it was.
      const blockerOf = new Map<string, { count: number; first: string } | null>();
      if (d.readiness) {
        const keys = [...new Set<string>(rows.filter((r: any) => r.status !== 'running').map((r: any) => r.channel_key))];
        await Promise.all(keys.map(async (k) => blockerOf.set(k, await d.readiness!.blockers(k).catch(() => null))));
      }
      return rows.map((r: any): WaitingItem => {
        if (r.status === 'running') {
          const st = r.graduation?.stats as GraduationStats | undefined;
          return {
            refId: `${r.id}:graduate`, title: `${r.channel_key}: готовий до Live`,
            body: [st ? graduationLineUk(st) : null,
              'Live: пости виходять без вашого схвалення; чисті пости, що зараз чекають, буде схвалено.'].filter(Boolean).join('\n\n'),
            path: launchPath(r.id), critical: false, since: new Date(r.graduation?.proposedAt ?? r.updated_at),
            buttons: [{ key: 'go_live', label: 'У Live', confirm: 'Так, у Live' }, { key: 'not_yet', label: 'Ще ні' }, { key: 'open', label: 'Відкрити' }],
          };
        }
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
        const blockers = blockerOf.get(r.channel_key) ?? null;
        return {
          refId: `${r.id}:start`, title: `${r.channel_key}: план запуску готовий`,
          // With blockers the summary is shortened so the readiness line fits the card (600 characters).
          body: [r.summary ? String(r.summary).slice(0, blockers ? 240 : 600) : null, blockers ? readinessLineUk(blockers) : null, botLineUk(r.channel_key, bot),
            'Старт застосує план і переведе канал у режим схвалення: пости чекатимуть вашого «так».'].filter(Boolean).join('\n\n'),
          path: launchPath(r.id), critical: false, since: new Date(r.updated_at),
          buttons: [
            { key: 'start', label: 'Старт', confirm: blockers ? 'Так, запустити попри блокери' : 'Так, запустити' },
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
        if (!r.started) return at('⏳ Старт прийнято: запущу, щойно бот стане адміністратором');
        // A31: the stored row, read once after Start (the recheck Start began may not have finished; the row is the last known one).
        const open = await openBlockers(id);
        return at(`✅ Запущено: пости чекають вашого схвалення${open ? `. Відкритих блокерів: ${open}` : ''}`);
      }
      if (key === 'check') {
        const { launch } = await d.launches.check(id);
        if (launch.status === 'running') return at('✅ Бот — адміністратор, запуск стартував');
        if (launch.bot?.state === 'ok') return at('✅ Бот — адміністратор');
        throw new Error(botLineUk(launch.channelKey, launch.bot));
      }
      if (key === 'go_live') {
        const r = await d.launches.goLive(id);
        return at(r.changed ? '✅ Канал у Live' : 'Канал уже в Live');
      }
      if (key === 'not_yet') {
        await d.launches.notYet(id);
        return at(`Добре: запропоную знову через ${SNOOZE_DAYS} днів і ще ${SNOOZE_MORE_APPROVED} схвалених постів`);
      }
      throw new Error(`unknown button ${key}`);
    },
  };
}
