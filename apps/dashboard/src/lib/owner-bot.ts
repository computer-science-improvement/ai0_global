// Spec 012 FR-007: the owner bot section's wording (what waits by kind, the bot's status).

import type { OwnerBotState } from '../api/owner-bot';

const KIND: Record<string, [string, string]> = {
  approval:  ['post to approve', 'posts to approve'],
  directive: ['directive', 'directives'],
  contested: ['contested directive', 'contested directives'],
  action:    ['agent card', 'agent cards'],
  steering:  ['steering set', 'steering sets'],
  setup:     ['setup from history', 'setups from history'],
  playbook:  ['playbook', 'playbooks'],
  inbox:     ['inbox note', 'inbox notes'],
};

export const kindText = (kind: string, n: number) => {
  const [one, many] = KIND[kind] ?? [kind, kind];
  return `${n} ${n === 1 ? one : many}`;
};

/** On, cards off, or not set up — and why. */
export function botStatus(s: OwnerBotState): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral'; note: string } {
  if (!s.configured.token || !s.configured.owner) {
    return { label: 'Not set up', tone: 'danger', note: !s.configured.token ? 'TELEGRAM_BOT_TOKEN is not set.' : 'Set the owner chat id in Settings → Telegram.' };
  }
  if (!s.polling.running) return { label: 'Not polling', tone: 'danger', note: 'The bot does not take updates: buttons and commands do not work. Restart the service.' };
  if (s.polling.lastError) return { label: 'Polling errors', tone: 'warning', note: `Last error: ${s.polling.lastError}` };
  if (!s.cardsOn) return { label: 'Cards off', tone: 'warning', note: 'Plain alerts instead of cards (Owner bot cards is off).' };
  return { label: 'On', tone: 'success', note: '' };
}
