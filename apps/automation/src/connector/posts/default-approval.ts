import type { ChannelMode } from '../../editor/card';

/**
 * Spec 103 D1: does a post prepared through the connector wait for the owner's approval?
 *
 * Default: only in an approve-mode channel (the owner approves there anyway). In a live channel the owner already
 * trusts the agents to post on their own, and a connector post goes out at its time. Callers can still pass
 * `needs_approval` explicitly. The owner's answer to D1 is a one-line change here.
 */
export function defaultNeedsApproval(mode: ChannelMode): boolean {
  return mode === 'approve';
}
