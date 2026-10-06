/**
 * Spec 031 T4 against a real throwaway Postgres: one Telegram alert per
 * resource per batch, deduped across restarts, none for an empty batch or a
 * batch still being written. A fake notifier — nothing is sent anywhere.
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { makeCard } from '../post/testing/fixtures';
import { ApprovalsRepository } from './approvals.repository';
import { ApprovalAlerts } from './approval-alerts';
import { syncAgentsFor } from './pg-test-agents';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const A = '@apv_alerts_a';
const B = '@apv_alerts_b';
// Tue 2030-05-07 20:30 Kyiv (UTC+3): the evening batch for Wednesday.
const NOW = new Date('2030-05-07T17:30:00Z');
let pool: Pool;

async function cleanup() {
  await pool.query(`DELETE FROM approval_alerts WHERE channel_key IN ($1, $2)`, [A, B]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key IN ($1, $2)`, [A, B]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key IN ($1, $2)`, [A, B]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  const channels = new EditorChannelsRepository(pool);
  await channels.upsert(makeCard({ channelKey: A, mode: 'approve', title: 'Космос' }));
  await channels.upsert(makeCard({ channelKey: B, mode: 'approve', title: 'Рецепти' }));
  await syncAgentsFor(pool, [A, B]);
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

async function plan(key: string, date: string): Promise<string> {
  return (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date, rationale) VALUES ($1, $2, 'x') RETURNING id`, [key, date])).rows[0].id;
}
async function slot(planId: string, key: string, at: string, status: string): Promise<string> {
  return (await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, created_at)
     VALUES ($1, $2, $3, 'text', 't', $4, '2030-05-07T09:00:00Z') RETURNING id`, [planId, key, at, status])).rows[0].id;
}

function alerts(sent: string[], fail = false) {
  const channels = new EditorChannelsRepository(pool);
  return new ApprovalAlerts({
    // Only this suite's channels: other pg suites running in parallel have waiting posts too.
    repo: new ApprovalsRepository(pool), card: (k) => ([A, B].includes(k) ? channels.get(k) : Promise.resolve(null)),
    notify: async (t) => { if (fail) throw new Error('telegram down'); sent.push(t); },
    dashboardUrl: 'https://dash.example',
  });
}

test('one alert per resource per batch, with the count and the link; none for an empty batch', { skip }, async () => {
  const pa = await plan(A, '2030-05-08');
  await slot(pa, A, '2030-05-08T07:00:00Z', 'awaiting_approval');
  await slot(pa, A, '2030-05-08T10:00:00Z', 'awaiting_approval');
  await slot(pa, A, '2030-05-08T15:00:00Z', 'skipped');
  const pb = await plan(B, '2030-05-08');
  await slot(pb, B, '2030-05-08T09:00:00Z', 'skipped'); // nothing waits: no alert

  const sent: string[] = [];
  assert.equal(await alerts(sent).run(NOW), 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Космос \(@apv_alerts_a\): 2 пости чекають апруву на завтра/);
  assert.match(sent[0], /https:\/\/dash\.example\/app\/agents\/inbox\?tab=approvals/);

  // The next tick, and a restarted process, send nothing for the same batch.
  assert.equal(await alerts(sent).run(new Date(NOW.getTime() + 60_000)), 0);
  assert.equal(await alerts(sent).run(new Date(NOW.getTime() + 3600_000)), 0);
  assert.equal(sent.length, 1);
});

test('no alert while the batch is still being written; a failed send is retried', { skip }, async () => {
  const pb = await plan(B, '2030-05-09');
  await slot(pb, B, '2030-05-09T07:00:00Z', 'awaiting_approval');
  const running = await slot(pb, B, '2030-05-09T09:00:00Z', 'running');
  const at = new Date('2030-05-08T17:10:00Z'); // Wed 20:10 Kyiv — Thursday's batch
  const sent: string[] = [];
  assert.equal(await alerts(sent).run(at), 0, 'a slot is being written');

  await pool.query(`UPDATE editor_slots SET status = 'planned' WHERE id = $1`, [running]);
  assert.equal(await alerts(sent).run(at), 0, 'a slot is due to be written (its batch time has come)');

  await pool.query(`UPDATE editor_slots SET status = 'awaiting_approval' WHERE id = $1`, [running]);
  assert.equal(await alerts([], true).run(at), 0, 'Telegram down: nothing sent…');
  assert.equal(await alerts(sent).run(at), 1, '…and the next tick retries');
  assert.match(sent[0], /Рецепти \(@apv_alerts_b\): 2 пости чекають апруву на завтра/);
});
