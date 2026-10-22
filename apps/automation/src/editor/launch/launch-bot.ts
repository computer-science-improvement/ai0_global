import type { LaunchBotState } from './launch.types';
import { errText } from '../../common/err-text';

/**
 * Spec 052 FR-002 `bot_admin`: the Bot API check of a channel being launched — `getMe`, `getChat` (title, description)
 * and `getChatMember` for the bot. Ok = the bot is the creator, or an administrator that may post. The texts are English
 * (the dashboard shows them); the owner bot card words them in Ukrainian.
 */
export function makeLaunchBotCheck(
  resolve: (channelKey: string) => { chatId: string | number; botToken: string },
  fetchImpl: typeof fetch = fetch,
) {
  return async (channelKey: string): Promise<LaunchBotState> => {
    let ch: { chatId: string | number; botToken: string };
    try { ch = resolve(channelKey); } catch (err: any) { return { state: 'unknown', detail: errText(err).slice(0, 200), bot: null }; }
    const call = async (method: string, params: Record<string, unknown>) => {
      const res = await fetchImpl(`https://api.telegram.org/bot${ch.botToken}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(10_000),
      });
      return res.json() as Promise<any>;
    };
    try {
      const me = await call('getMe', {});
      if (!me?.ok) return { state: 'token_invalid', detail: 'the bot token is invalid', bot: null };
      const bot = me.result?.username ? `@${me.result.username}` : null;
      const chat = await call('getChat', { chat_id: ch.chatId });
      if (!chat?.ok) {
        const why = String(chat?.description ?? '');
        return {
          state: 'no_access', bot,
          detail: /not found/i.test(why) ? `${bot ?? 'the bot'} cannot see the channel yet — add it as an administrator` : (why || 'the bot cannot see the channel'),
        };
      }
      const info = { chatTitle: chat.result?.title ?? null, chatAbout: chat.result?.description ?? null };
      const member = await call('getChatMember', { chat_id: ch.chatId, user_id: me.result.id });
      if (!member?.ok) return { state: 'no_access', bot, detail: member?.description ?? 'the bot cannot see the channel', ...info };
      const m = member.result;
      if (m.status === 'creator') return { state: 'ok', bot, detail: `${bot} owns the channel`, ...info };
      if (m.status !== 'administrator') return { state: 'no_access', bot, detail: `${bot} is not an administrator yet`, ...info };
      if (m.can_post_messages === false) return { state: 'no_access', bot, detail: `${bot} is an administrator without the right to post messages`, ...info };
      return { state: 'ok', bot, detail: `${bot} is an administrator and may post`, ...info };
    } catch (err: any) {
      return { state: 'unknown', bot: null, detail: `Bot API unavailable: ${errText(err).slice(0, 160)}` };
    }
  };
}
