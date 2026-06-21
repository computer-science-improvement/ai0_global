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
  return { ctrl: new AgentController(repo, client, config, actionsRepo, actionsSvc), calls };
}

function makeCtrlWithActions(actionsRepo: any, actionsSvc: any) {
  const repo = {
    list: async () => [],
    setStatus: async () => {},
    lastPolledAt: async () => new Date(),
  } as any;
  const client = { hasSession: async () => true } as any;
  const config = { get: () => 'true' } as any;
  return new AgentController(repo, client, config, actionsRepo, actionsSvc);
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
