import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentInboxPoller } from './agent-inbox.poller';

function harness(opts: { enabled?: boolean; hasSession?: boolean; dialogs?: any[]; lastIds?: Record<string, number>; category?: string; channel?: string; prices?: any[]; pending?: boolean }) {
  const triaged: string[] = [];
  const upserts: any[] = [];
  const client = {
    hasSession: async () => opts.hasSession ?? true,
    fetchRecentDialogs: async () => opts.dialogs ?? [],
  } as any;
  const drafts: any[] = [];
  const triage = { triage: async (text: string) => { triaged.push(text); return { category: opts.category ?? 'ad', summary: '', fields: { channel: opts.channel }, draftReply: '', score: 1 }; } } as any;
  const repo = {
    lastMessageIdFor: async (peer: string) => (opts.lastIds ?? {})[peer] ?? 0,
    upsertThread: async (dm: any) => { upserts.push(dm); return `th-${dm.peerId}`; },
    touchCursor: async () => {},
  } as any;
  const config = { get: (k: string) => (k === 'AGENT_ENABLED' ? (opts.enabled ? 'true' : 'false') : undefined) } as any;
  const actions = {
    hasPending: async () => opts.pending ?? false,
    create: async (a: any) => { drafts.push(a); return { id: 'a1' }; },
  } as any;
  const prices = { list: async () => opts.prices ?? [
    { id: 'p1', channel_key: '@space_ua', format: 'post', price_uah: 1500, active: true, note: null },
    { id: 'p2', channel_key: '@recipes_ua', format: 'post', price_uah: 800, active: true, note: null },
  ] } as any;
  return { poller: new AgentInboxPoller(client, triage, repo, config, actions, prices), triaged, upserts, drafts };
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

test('ad inquiry → a pending reply draft with the price list of the named channel', async () => {
  const h = harness({ enabled: true, dialogs: [dm('1', 5)], channel: 't.me/space_ua' });
  await h.poller.pollOnce();
  assert.equal(h.drafts.length, 1);
  assert.equal(h.drafts[0].type, 'reply');
  assert.equal(h.drafts[0].threadId, 'th-1');
  assert.match(h.drafts[0].payload.text, /@space_ua\n• рекламний пост: 1 500 грн/);
  assert.doesNotMatch(h.drafts[0].payload.text, /recipes_ua/);
});

test('no draft for non-ad DMs, without active prices, or when a draft is already pending', async () => {
  const a = harness({ enabled: true, dialogs: [dm('1', 5)], category: 'question' });
  await a.poller.pollOnce();
  assert.equal(a.drafts.length, 0);
  const b = harness({ enabled: true, dialogs: [dm('1', 5)], prices: [] });
  await b.poller.pollOnce();
  assert.equal(b.drafts.length, 0);
  const c = harness({ enabled: true, dialogs: [dm('1', 5)], pending: true });
  await c.poller.pollOnce();
  assert.equal(c.drafts.length, 0);
});
