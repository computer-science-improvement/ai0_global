import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentController } from './agent.controller';

function make() {
  const calls: any[] = [];
  const repo = {
    list: async (f: any) => { calls.push(['list', f]); return [{ id: 'a', peer_id: '1' }]; },
    setStatus: async (id: string, s: string) => { calls.push(['setStatus', id, s]); },
    lastPolledAt: async () => new Date('2026-01-01T00:00:00Z'),
  } as any;
  const client = { hasSession: async () => true } as any;
  const config = { get: (k: string) => (k === 'AGENT_ENABLED' ? 'true' : '*/5 * * * *') } as any;
  const actionsRepo = { list: async () => [], create: async () => ({}) } as any;
  const actionsSvc = { approve: async () => ({}), reject: async () => ({}) } as any;
  const chatsRepo = { list: async () => [] } as any;
  const oppsRepo = { list: async () => [] } as any;
  return { ctrl: new AgentController(repo, client, config, actionsRepo, actionsSvc, chatsRepo, oppsRepo), calls };
}

function makeCtrlWithActions(actionsRepo: any, actionsSvc: any) {
  const repo = {
    list: async () => [],
    setStatus: async () => {},
    lastPolledAt: async () => new Date(),
  } as any;
  const client = { hasSession: async () => true } as any;
  const config = { get: () => 'true' } as any;
  const chatsRepo = { list: async () => [] } as any;
  const oppsRepo = { list: async () => [] } as any;
  return new AgentController(repo, client, config, actionsRepo, actionsSvc, chatsRepo, oppsRepo);
}

test('GET inbox passes status+category filter through', async () => {
  const { ctrl, calls } = make();
  const rows = await ctrl.inbox('new', 'ad');
  assert.equal(rows.length, 1);
  assert.deepEqual(calls[0], ['list', { status: 'new', category: 'ad' }]);
});

test('PATCH validates status and calls setStatus', async () => {
  const { ctrl, calls } = make();
  await ctrl.patch('a', { status: 'archived' });
  assert.deepEqual(calls[0], ['setStatus', 'a', 'archived']);
});

test('GET status reports enabled + hasSession', async () => {
  const { ctrl } = make();
  const s = await ctrl.status();
  assert.equal(s.enabled, true);
  assert.equal(s.hasAgentSession, true);
});

test('GET actions lists by status', async () => {
  const calls: any[] = [];
  const actionsRepo = { list: async (s: any) => { calls.push(['list', s]); return [{ id: 'a' }]; } } as any;
  const actionsSvc = {} as any;
  const ctrl = makeCtrlWithActions(actionsRepo, actionsSvc);
  const r = await ctrl.actions('pending');
  assert.deepEqual(calls[0], ['list', 'pending']);
  assert.equal(r.length, 1);
});

test('POST approve calls service.approve', async () => {
  const calls: any[] = [];
  const actionsSvc = { approve: async (id: string) => { calls.push(['approve', id]); return { id, status: 'done' }; } } as any;
  const ctrl = makeCtrlWithActions({} as any, actionsSvc);
  const r = await ctrl.approveAction('a');
  assert.equal(r.status, 'done');
});

function makeCtrlWithChatIntel(client: any, chatsRepo: any, oppsRepo: any) {
  const repo = {
    list: async () => [],
    setStatus: async () => {},
    lastPolledAt: async () => new Date(),
  } as any;
  const config = { get: () => 'true' } as any;
  const actionsRepo = { list: async () => [], create: async () => ({}) } as any;
  const actionsSvc = { approve: async () => ({}), reject: async () => ({}) } as any;
  return new AgentController(repo, client, config, actionsRepo, actionsSvc, chatsRepo, oppsRepo);
}

test('GET chats merges joined groups with monitored flags', async () => {
  const client = { listGroups: async () => [{ chatId: 'c1', title: 'One' }, { chatId: 'c2', title: 'Two' }] } as any;
  const chatsRepo = { list: async () => [{ chat_id: 'c1', enabled: true }] } as any;
  const ctrl = makeCtrlWithChatIntel(client, chatsRepo, {} as any);
  const r = await ctrl.chats();
  assert.equal(r.length, 2);
  assert.equal(r.find((x: any) => x.chatId === 'c1')!.enabled, true);
  assert.equal(r.find((x: any) => x.chatId === 'c2')!.enabled, false);
});
test('POST monitor upserts + sets enabled', async () => {
  const calls: any[] = [];
  const client = { listGroups: async () => [{ chatId: 'c1', title: 'One' }] } as any;
  const chatsRepo = { upsert: async (id: string, t: string) => calls.push(['upsert', id, t]), setEnabled: async (id: string, e: boolean) => calls.push(['enable', id, e]) } as any;
  const ctrl = makeCtrlWithChatIntel(client, chatsRepo, {} as any);
  await ctrl.monitor('c1', { enabled: true });
  assert.ok(calls.some(c => c[0] === 'enable' && c[2] === true));
});
test('GET opportunities lists by status/kind', async () => {
  const oppsRepo = { list: async (f: any) => [{ id: 'o1' }] } as any;
  const ctrl = makeCtrlWithChatIntel({} as any, {} as any, oppsRepo);
  const r = await ctrl.opportunities('new', 'ad_offer');
  assert.equal(r.length, 1);
});
