import type { Finding } from '../../sysadmin/audit.types';
import { mkFinding } from '../finding';
import type { ChannelFacts } from '../facts.types';
import type { DoctorCheck } from './index';

/**
 * Spec 072 FR-003.5: the open launch. A bot that is no administrator of the channel (or whose token no longer works) cannot
 * publish the first post, however good the plan is. The state is the one the launch stored at its last Bot API check.
 */

/** The launch as a 048 artifact; the same path as `launchPath` in `launch/launch-cards.ts` (a test keeps the two equal). */
export const launchArtifactPath = (id: string) => `/app/artifacts?type=launch&open=launch:${encodeURIComponent(id)}`;

export const BOT_BLOCKING_STATES: readonly string[] = ['no_access', 'token_invalid'];

export const launchCheck: DoctorCheck = {
  code: 'bot_not_admin',
  run(f: ChannelFacts): Finding[] {
    const l = f.launch;
    const bot = l?.botState;
    if (!l || !bot || !BOT_BLOCKING_STATES.includes(bot.state)) return [];
    const who = bot.bot ? `The bot ${bot.bot}` : 'The bot';
    return [mkFinding(f, {
      code: 'bot_not_admin', severity: 'error',
      subject: { type: 'channel', id: l.id, label: 'Launch' },
      detail: bot.state === 'token_invalid'
        ? `${who} token is no longer accepted by Telegram, so nothing can be posted to ${f.channelKey}.`
        : `${who} is not an administrator of ${f.channelKey}, so it cannot post there.`,
      evidence: { launch_id: l.id, launch_status: l.status, state: bot.state, detail: bot.detail, bot: bot.bot },
      link: launchArtifactPath(l.id),
    })];
  },
};
