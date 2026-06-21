import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentInboxPoller } from './agent-inbox.poller';

function harness(opts: { enabled?: boolean; hasSession?: boolean; dialogs?: any[]; lastIds?: Record<string, number> }) {
  const triaged: string[] = [];
  const upserts: any[] = [];
  const client = {
    hasSession: async () => opts.hasSession ?? true,
    fetchRecentDialogs: async () => opts.dialogs ?? [],
  } as any;
  const triage = { triage: async (text: string) => { triaged.push(text); return { category: 'ad', summary: '', fields: {}, draftReply: '', score: 1 }; } } as any;
  const repo = {
    lastMessageIdFor: async (peer: string) => (opts.lastIds ?? {})[peer] ?? 0,
    upsertThread: async (dm: any) => { upserts.push(dm); },
    touchCursor: async () => {},
  } as any;
  const config = { get: (k: string) => (k === 'AGENT_ENABLED' ? (opts.enabled ? 'true' : 'false') : undefined) } as any;
  return { poller: new AgentInboxPoller(client, triage, repo, config), triaged, upserts };
}

const dm = (peerId: string, messageId: number, out = false) =>
  ({ peerId, peerUsername: null, peerName: null, messageId, text: `m${messageId}`, date: new Date(), out });

test('no-op when AGENT_ENABLED is false', async () => {
  const h = harness({ enabled: false, dialogs: [dm('1', 5)] });
  const r = await h.poller.pollOnce();
  assert.equal(r.triaged, 0);
  assert.equal(h.upserts.length, 0);
});

test('no-op when no agent session', async () => {
  const h = harness({ enabled: true, hasSession: false, dialogs: [dm('1', 5)] });
  const r = await h.poller.pollOnce();
  assert.equal(r.triaged, 0);
});

test('triages + upserts only new incoming dialogs', async () => {
  const h = harness({ enabled: true, dialogs: [dm('1', 5), dm('2', 3, true), dm('3', 9)], lastIds: { '3': 9 } });
  const r = await h.poller.pollOnce();
  // peer 1 new (5>0) → keep; peer 2 outgoing → drop; peer 3 not newer (9>9 false) → drop
  assert.equal(r.triaged, 1);
  assert.equal(h.upserts.length, 1);
  assert.equal(h.upserts[0].peerId, '1');
});
