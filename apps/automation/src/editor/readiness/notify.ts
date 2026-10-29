import { createHash } from 'crypto';
import type { Finding } from '../sysadmin/audit.types';
import { isAutoFixed } from './view';

/**
 * Spec 072 FR-009, A9, I9: which blockers the owner-bot readiness card may name, and the id of the card.
 *
 * Some things already have a note of their own, so the readiness card leaves them out: 076 sends its host note for a source
 * that cannot be read, 060 sends `series_paused` for a paused series, and the launch card says it waits for the bot, so
 * `bot_not_admin` is left out while a launch is open for the channel. They are still findings in the panel and still counted in
 * `blockers`; only the stamp (`notified_blockers`) and the card ignore them.
 */
export const NOTED_ELSEWHERE_CODES: readonly string[] = ['source_probe_failed', 'series_paused', 'series_paused_by_owner', 'pause_cause_gone'];

export function notedElsewhere(f: Pick<Finding, 'check'>, o: { launchOpen: boolean }): boolean {
  return NOTED_ELSEWHERE_CODES.includes(f.check) || (f.check === 'bot_not_admin' && o.launchOpen);
}

/** The open errors the readiness card may name. */
export const notifiable = (findings: readonly Finding[], o: { launchOpen: boolean }): Finding[] =>
  findings.filter((f) => f.severity === 'error' && !isAutoFixed(f) && !notedElsewhere(f, o));

/**
 * A9: `owner_cards` is unique on (kind, ref_id) and never reinserts, so the id carries the set and the day it was stamped:
 * `<channelKey>|<first 8 hex of sha1 of the sorted keys>|<yyyymmdd UTC of notified_at>`. The same set coming back on another
 * day is a new card; a new set is a new card.
 */
export function readinessRefId(channelKey: string, notifiedBlockers: readonly string[], notifiedAt: Date): string {
  const sha = createHash('sha1').update([...notifiedBlockers].sort().join(',')).digest('hex').slice(0, 8);
  return `${channelKey}|${sha}|${notifiedAt.toISOString().slice(0, 10).replace(/-/g, '')}`;
}

/** The channel key of a card's ref id. */
export const channelOfRefId = (refId: string): string => refId.split('|')[0];
