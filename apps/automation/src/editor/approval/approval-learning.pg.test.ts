/**
 * Spec 031 T6 against a real throwaway Postgres: the stats of a seeded window
 * (what counts as a decision, the 14-day cut, per resource, median time to
 * approve from the writing run) and a reject reason landing in the channel
 * memory as an owner preference. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { EditorMemoryRepository } from '../repo/editor-memory.repository';
import { makeCard } from '../post/testing/fixtures';
import { ApprovalsRepository } from './approvals.repository';
import { ApprovalsService } from './approvals.service';
import { ApprovalStatsRepository } from './approval-stats';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@t6_learn_pg';
const IG = 'instagram:t6-learn-ig';
let pool: Pool;

async function cleanup() {
  await pool.query(`DELETE FROM editor_runs WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_channel_memory WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  await pool.query(`INSERT INTO editor_channels (channel_key, mode, title) VALUES ($1, 'approve', 'Навчання')`, [CH]);
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

const H = 3600_000;

test('stats: decisions of the window per resource; median wait from the writing run; dropped and old posts left out', { skip }, async () => {
  const now = new Date();
  const plan = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ($1, CURRENT_DATE) RETURNING id`, [CH])).rows[0].id;
  const run = async (finished: Date) => (await pool.query(
    `INSERT INTO editor_runs (role, channel_key, model, status, started_at, finished_at) VALUES ('executor', $1, 'fake', 'ok', $2, $2) RETURNING id`,
    [CH, finished])).rows[0].id as string;
  const slot = async (o: { status: string; approvedAt?: Date | null; edited?: boolean; error?: string | null; reason?: string | null; updatedAt?: Date; runId?: string | null; ref?: string | null }) =>
    (await pool.query(
      `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, approved_at, approved_by, owner_edited, error, reject_reason, updated_at, run_id, resource_ref)
       VALUES ($1, $2, now() + interval '1 day', 'text', 't', $3, $4, CASE WHEN $4::timestamptz IS NULL THEN NULL ELSE 'owner' END, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [plan, CH, o.status, o.approvedAt ?? null, o.edited ?? false, o.error ?? null, o.reason ?? null, o.updatedAt ?? now, o.runId ?? null, o.ref ?? null])).rows[0].id as string;

  const a1 = new Date(now.getTime() - 24 * H);
  await slot({ status: 'published', approvedAt: a1, runId: await run(new Date(a1.getTime() - H)) });                    // clean, waited 1 h
  const a2 = new Date(now.getTime() - 48 * H);
  await slot({ status: 'approved', approvedAt: a2, edited: true, runId: await run(new Date(a2.getTime() - 2 * H)), ref: IG }); // edited, 2 h
  await slot({ status: 'skipped', error: 'rejected by owner', reason: 'Тема вчорашня', updatedAt: new Date(now.getTime() - 24 * H) });
  await slot({ status: 'expired', error: 'expired: not approved in time', updatedAt: new Date(now.getTime() - 72 * H) });
  await slot({ status: 'published', approvedAt: new Date(now.getTime() - 20 * 24 * H) });                             // outside 14 days
  await slot({ status: 'skipped', error: 'mode_changed' });                                                           // not a decision
  await slot({ status: 'skipped', error: 'skipped by agent: слабке' });                                               // not a decision
  await slot({ status: 'awaiting_approval' });                                                                        // waiting

  const stats = new ApprovalStatsRepository(pool);
  const r = await stats.report({ channel: CH, days: 14, now });
  assert.deepEqual(
    { ...r.totals, topRejectReasons: r.totals.topRejectReasons },
    {
      approved: 2, approvedClean: 1, edited: 1, rejected: 1, expired: 1, approvalRate: 0.667, editRate: 0.5, cleanRate: 0.5,
      medianTimeToApproveSec: 5400, topRejectReasons: [{ reason: 'Тема вчорашня', count: 1 }], rejectedWithoutReason: 0, waiting: 1,
    });
  assert.deepEqual(r.byResource.map((x) => [x.resourceRef, x.approved, x.rejected, x.expired]), [[`telegram:${CH}`, 1, 1, 1], [IG, 1, 0, 0]]);

  const ig = await stats.report({ resource: IG, days: 14, now });
  assert.deepEqual([ig.totals.approved, ig.totals.edited, ig.totals.medianTimeToApproveSec, ig.totals.waiting], [1, 1, 7200, 0]);
  const tg = await stats.report({ resource: `telegram:${CH}`, days: 30, now });
  assert.equal(tg.totals.approved, 2, '30 days include the old approval; the Telegram resource only');
});

test('a reject reason is saved as an owner preference: listed for the prompts, kept out of the general memory block', { skip }, async () => {
  const plan = (await pool.query(`SELECT id FROM editor_plans WHERE channel_key = $1 LIMIT 1`, [CH])).rows[0].id;
  const id = (await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status) VALUES ($1, $2, now() + interval '30 minutes', 'text', 'Затемнення', 'awaiting_approval') RETURNING id`,
    [plan, CH])).rows[0].id as string;
  const memory = new EditorMemoryRepository(pool);
  await memory.add(CH, 'rule', 'Без емодзі в заголовках', null, 'owner');
  const svc = new ApprovalsService({
    repo: new ApprovalsRepository(pool), card: async () => makeCard({ channelKey: CH }),
    remember: (key, pref) => memory.add(key, pref.kind, pref.text, pref.evidence, 'owner'),
  });
  await svc.reject(id, { reason: 'тема була вчора' });

  const prefs = await memory.ownerPreferences(CH, 20);
  assert.equal(prefs.length, 1);
  assert.equal(prefs[0].text, 'Власник відхилив пост «Затемнення»: тема була вчора');
  assert.equal(prefs[0].kind, 'avoid');
  assert.equal((prefs[0].evidence as any).slotId, id);
  const general = await memory.listActive(CH, 30, { excludeApprovalPrefs: true });
  assert.deepEqual(general.map((m) => m.text), ['Без емодзі в заголовках']);
  assert.equal((await memory.listActive(CH)).length, 2, 'the agent page and get_channel_memory still see everything');
});
