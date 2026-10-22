import { createHash } from 'node:crypto';
import type { OwnerInbox } from '../agents/owner-inbox';
import { SETUP_SECTIONS } from './setup-analysis';
import type { ChannelSetupRepository, SetupProposal } from './setup.repository';
import { errText } from '../../common/err-text';

/**
 * Spec 057: proposals that nobody applied close by themselves. A `ready` / `partially_applied` proposal untouched for
 * SETUP_PROPOSAL_TTL_DAYS days (default 14; 0 = never) becomes `expired`. Code only — no LLM. The sweep runs from the
 * channel-setup minute tick, at most once an hour (the SQL is idempotent anyway), and leaves one Inbox note per sweep.
 */

export const SETUP_TTL_DEFAULT_DAYS = 14;
export const SETUP_TTL_MAX_DAYS = 365;
export const EXPIRY_SWEEP_EVERY_MS = 3_600_000;
export const SETUP_EXPIRED_KIND = 'setup_expired';
const LISTED_CHANNELS = 10;

/** SETUP_PROPOSAL_TTL_DAYS as the sweep reads it: an integer 0–365, anything else is the default. */
export function setupTtlDays(raw: string | undefined | null): number {
  if (raw == null || String(raw).trim() === '') return SETUP_TTL_DEFAULT_DAYS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= SETUP_TTL_MAX_DAYS ? n : SETUP_TTL_DEFAULT_DAYS;
}

/** The Inbox note for one sweep: the channels listed once each. The dashboard copy is English, the Telegram alert Ukrainian. */
export function expiryNote(expired: readonly Pick<SetupProposal, 'id' | 'channelKey'>[], ttlDays: number) {
  const channels = [...new Set(expired.map((p) => p.channelKey))].sort();
  const shown = channels.slice(0, LISTED_CHANNELS);
  const more = channels.length - shown.length;
  const en = shown.join(', ') + (more > 0 ? ` and ${more} more` : '');
  const uk = shown.join(', ') + (more > 0 ? ` і ще ${more}` : '');
  const ids = expired.map((p) => p.id).sort();
  const n = expired.length;
  const ukWord = n % 10 === 1 && n % 100 !== 11 ? 'пропозицію' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'пропозиції' : 'пропозицій';
  return {
    // Same ids = same note (postOnce): a retry after a failed post does not repeat it.
    refType: 'setup_proposals', refId: createHash('sha1').update(ids.join(',')).digest('hex').slice(0, 24),
    title: `Setup proposal${n === 1 ? '' : 's'} expired: ${en}`,
    body: `${n} setup proposal${n === 1 ? ' was' : 's were'} not applied for ${ttlDays} days and ${n === 1 ? 'is' : 'are'} closed (${en}). `
      + 'Sections that were already applied stay. Run a new analysis with "Set up from history" on the agent page or /setup @channel in the chat.',
    alert: {
      title: `Пропозиції налаштування закрито за терміном: ${uk}`,
      body: `${n} ${ukWord} не застосовували ${ttlDays} дн. — ${n % 10 === 1 && n % 100 !== 11 ? 'її' : 'їх'} закрито (${uk}). `
        + 'Розділи, які вже застосовано, лишаються. Нову пропозицію можна запустити кнопкою «Set up from history» на сторінці агента або командою /setup @канал у чаті.',
    },
  };
}

export interface SetupExpiryDeps {
  repo:     Pick<ChannelSetupRepository, 'expireStale'>;
  inbox?:   Pick<OwnerInbox, 'postOnce'>;
  /** The TTL now (the setting is live): days, 0 = never. */
  ttlDays:  () => number;
  now?:     () => Date;
  everyMs?: number;
  log?:     (msg: string) => void;
}

export class SetupExpiry {
  private lastRun = 0;

  constructor(private readonly d: SetupExpiryDeps) {}

  /** Throttled sweep; the proposals it expired (none when throttled or the TTL is 0). */
  async sweep(): Promise<SetupProposal[]> {
    const now = (this.d.now ?? (() => new Date()))();
    const every = this.d.everyMs ?? EXPIRY_SWEEP_EVERY_MS;
    if (every > 0 && this.lastRun && now.getTime() - this.lastRun < every) return [];
    this.lastRun = now.getTime();
    const ttl = this.d.ttlDays();
    if (!(ttl > 0)) return [];
    const expired = await this.d.repo.expireStale(now, ttl, SETUP_SECTIONS);
    if (!expired.length) return [];
    this.d.log?.(`setup proposals expired after ${ttl} days: ${expired.map((p) => p.channelKey).join(', ')}`);
    if (this.d.inbox) {
      try {
        await this.d.inbox.postOnce({ kind: SETUP_EXPIRED_KIND, severity: 'info', ...expiryNote(expired, ttl) });
      } catch (err: any) {
        this.d.log?.(`setup expiry note failed: ${errText(err)}`);
      }
    }
    return expired;
  }
}
