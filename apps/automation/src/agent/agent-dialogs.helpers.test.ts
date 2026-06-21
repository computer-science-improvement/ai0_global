import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectNewIncoming } from './agent-dialogs.helpers';

const lastIds = new Map<string, number>([['42', 100]]);
const dms = [
  { peerId: '42', peerUsername: null, peerName: 'A', messageId: 100, text: 'old', date: new Date(), out: false }, // already seen
  { peerId: '42', peerUsername: null, peerName: 'A', messageId: 101, text: 'new', date: new Date(), out: false }, // newer → keep
  { peerId: '7',  peerUsername: null, peerName: 'B', messageId: 5,   text: 'first', date: new Date(), out: false }, // unseen → keep
  { peerId: '9',  peerUsername: null, peerName: 'C', messageId: 9,   text: 'mine', date: new Date(), out: true },  // outgoing → drop
];

test('keeps only incoming messages newer than the per-peer last id', () => {
  const out = selectNewIncoming(dms as any, lastIds);
  const ids = out.map(d => d.messageId).sort((a, b) => a - b);
  assert.deepEqual(ids, [5, 101]);
});
