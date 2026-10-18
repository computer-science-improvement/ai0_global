/** A card made outside a chat (@manager's edit_data_schema) opens by id from "Waiting for you" — no page held it before. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentsService } from './agents.service';
import { PendingActionsService } from './pending-actions';

test('GET /api/agents/actions/:id returns the card; an unknown id is 404', async () => {
  const card = { id: '0b1f6a8e-7d1e-4f0e-9b1a-1c2d3e4f5a6b', chatId: null, agentId: 'm', kind: 'edit_data_schema', payload: { dataset: 'prompts' }, summary: 'Edit prompts description', status: 'pending' };
  const actions = new PendingActionsService({ get: async (id: string) => (id === card.id ? card : null) } as any);
  const svc = new AgentsService({
    pool: { query: async () => ({ rows: [] }) } as any, agents: {} as any, skills: {} as any, inbox: {} as any, actions,
    setChannelMode: async () => {}, runNow: async () => ({ started: false, what: '' }), memory: async () => [],
  });
  assert.deepEqual(await svc.action(card.id), { action: card });
  await assert.rejects(svc.action('00000000-0000-0000-0000-000000000000'), (e: any) => e.response?.error === 'action_not_found');
});
