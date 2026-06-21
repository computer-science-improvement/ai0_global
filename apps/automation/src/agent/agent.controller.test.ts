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
  return { ctrl: new AgentController(repo, client, config), calls };
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
