import type { RawDm } from './agent.types';

/** Keep incoming DMs strictly newer than the per-peer last-seen message id. */
export function selectNewIncoming(dms: RawDm[], lastIdByPeer: Map<string, number>): RawDm[] {
  return dms.filter(d => !d.out && d.messageId > (lastIdByPeer.get(d.peerId) ?? 0));
}
