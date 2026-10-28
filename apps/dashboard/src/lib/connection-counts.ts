// Spec 078 C2: the numbers on the Connections page tabs and its eyebrow line. A count stays `undefined` while its list has not
// loaded (or its endpoint answered an error), so a tab shows no number instead of a false 0.

import type { Bot, MetaAccount, MtprotoSession, TelegraphAccount } from '../api/types';
import type { TikTokAccount } from '../api/tiktok-accounts';

export interface ConnectionLists {
  sessions?:  readonly MtprotoSession[];
  bots?:      readonly Bot[];
  telegraph?: readonly TelegraphAccount[];
  meta?:      readonly MetaAccount[];
  tiktok?:    readonly TikTokAccount[];
}

export interface ConnectionCounts {
  sessions?: number; bots?: number; telegraph?: number;
  facebook?: number; instagram?: number; threads?: number; tiktok?: number;
  /** Sum of the Telegram tabs / of the three Meta platforms (only when every part has loaded). */
  telegram?: number; meta?: number;
  /** Connections that show an error right now, over the lists that have loaded. */
  problems: number;
}

/** Meta account whose last verify failed, or whose token reported itself invalid. */
export const metaHasProblem = (a: Pick<MetaAccount, 'verify_error' | 'token_checked_at' | 'token_valid'>): boolean =>
  !!a.verify_error || (!!a.token_checked_at && a.token_valid === false);

const sum = (...n: Array<number | undefined>): number | undefined =>
  n.some((x) => x === undefined) ? undefined : n.reduce<number>((s, x) => s + (x ?? 0), 0);

export function connectionCounts(l: ConnectionLists): ConnectionCounts {
  const onPlatform = (p: MetaAccount['platform']) => l.meta?.filter((a) => a.platform === p).length;
  const facebook = onPlatform('facebook');
  const instagram = onPlatform('instagram');
  const threads = onPlatform('threads');
  const sessions = l.sessions?.length;
  const bots = l.bots?.length;
  const telegraph = l.telegraph?.length;
  const problems =
    (l.sessions?.filter((s) => !!s.verify_error).length ?? 0) +
    (l.bots?.filter((b) => !!b.verify_error).length ?? 0) +
    (l.telegraph?.filter((t) => !!t.verify_error).length ?? 0) +
    (l.meta?.filter(metaHasProblem).length ?? 0) +
    (l.tiktok?.filter((t) => !!t.refresh_error).length ?? 0);
  return {
    sessions, bots, telegraph, facebook, instagram, threads, tiktok: l.tiktok?.length,
    telegram: sum(sessions, bots, telegraph),
    meta: sum(facebook, instagram, threads),
    problems,
  };
}
