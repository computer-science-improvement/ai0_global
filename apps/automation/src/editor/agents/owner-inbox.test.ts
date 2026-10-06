// AI0-79: Inbox items are dashboard copy (English); the owner's Telegram alert can keep its own wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OwnerInbox } from './owner-inbox';

function setup() {
  const inserted: unknown[][] = [];
  const alerts: string[] = [];
  const pool = { query: async (_sql: string, params: unknown[]) => { inserted.push(params); return { rows: [{ id: 7 }] }; } } as any;
  const inbox = new OwnerInbox(pool, async (t) => { alerts.push(t); }, 'https://dash.example/');
  return { inbox, inserted, alerts };
}

test('without an alert override the Telegram alert repeats the stored title and body', async () => {
  const s = setup();
  assert.equal(await s.inbox.post({ kind: 'k', severity: 'action', title: 'Title', body: 'Body' }), 7);
  assert.deepEqual(s.inserted[0].slice(2, 4), ['Title', 'Body']);
  assert.equal(s.alerts[0], '🟡 Title\n\nBody\nhttps://dash.example/app/agents/inbox');
});

test('an alert override changes only the Telegram text; the stored item keeps the dashboard copy', async () => {
  const s = setup();
  await s.inbox.post({ kind: 'k', severity: 'critical', title: 'Budget exhausted', body: 'Spent $1 of $1', alert: { title: 'Бюджет вичерпано', body: 'Витрачено $1 із $1' } });
  assert.deepEqual(s.inserted[0].slice(2, 4), ['Budget exhausted', 'Spent $1 of $1']);
  assert.equal(s.alerts[0], '🚨 Бюджет вичерпано\n\nВитрачено $1 із $1\nhttps://dash.example/app/agents/inbox');
});
