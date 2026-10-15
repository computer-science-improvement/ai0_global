/**
 * Spec 037 FR-010 (T10) on a throwaway Postgres with every migration applied: migration 076 (editor_slots.fallback,
 * the once-per-resource-per-day index; re-apply), the fallback trace round trip through EditorPlansRepository, the
 * SilentDaysWatch reading real slots on a fake clock and posting through the real OwnerInbox — one dark_day and one
 * series_missed note per resource per day — and the MANAGER digest's plan block from SQL. Skipped unless
 * EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { OwnerInbox, dailyRef } from '../agents/owner-inbox';
import { EditorPlansRepository } from '../repo/editor-plans.repository';
import { SqlQuality } from '../manager/quality-digest';
import { makeCard } from '../post/testing/fixtures';
import { SilentDaysWatch } from './silent-days';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pgt037silent';
const REF = `telegram:${CH}`;
const MIGRATION = join(__dirname, '../../../../../database/migrations/076_silent_days.sql');
let pool: Pool;
let planId: string;

async function cleanup() {
  await pool.query(`DELETE FROM agent_inbox WHERE ref_id LIKE $1`, [`${REF}|%`]);
  await pool.query(`DELETE FROM editor_slots WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
}

async function addSlot(o: { at: string; status: string; error?: string; series?: string; critic?: unknown }): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, error, series_name, critic, updated_at)
     VALUES ($1, $2, $3, 'photo', 'Тема', $4, $5, $6, $7, $3) RETURNING id`,
    [planId, CH, o.at, o.status, o.error ?? null, o.series ?? null, o.critic ? JSON.stringify(o.critic) : null]);
  return rows[0].id;
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  await pool.query(`INSERT INTO editor_channels (channel_key, timezone) VALUES ($1, 'Europe/Kyiv') ON CONFLICT (channel_key) DO NOTHING`, [CH]).catch(async () => {
    // Older column sets: the card row only needs the key and the zone for resource_tz().
    await pool.query(`INSERT INTO editor_channels (channel_key) VALUES ($1) ON CONFLICT DO NOTHING`, [CH]);
  });
  const { rows } = await pool.query(`INSERT INTO editor_plans (channel_key, plan_date, status, rationale) VALUES ($1, '2026-10-11', 'active', 'pg test') RETURNING id`, [CH]);
  planId = rows[0].id;
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

test('migration 076: re-applies cleanly; the fallback column and the resource-day index exist', { skip }, async () => {
  await pool.query(readFileSync(MIGRATION, 'utf8'));
  const { rows: col } = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'editor_slots' AND column_name = 'fallback'`);
  assert.equal(col.length, 1);
  const { rows: idx } = await pool.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_agent_inbox_resource_day'`);
  assert.match(idx[0].indexdef, /UNIQUE/);
  const { rows: v } = await pool.query(`SELECT 1 FROM schema_migrations WHERE version = '076_silent_days'`);
  assert.equal(v.length, 1);
});

test('fallback trace: stored and read back on the slot', { skip }, async () => {
  const id = await addSlot({ at: '2026-10-11T05:00:00Z', status: 'skipped', error: 'critic_rejected: reject' });
  const plans = new EditorPlansRepository(pool);
  const fallback = {
    steps: [{ step: 'initial' as const, at: '2026-10-11T05:00:00Z', format: 'photo', outcome: 'critic_reject' as const, reason: 'x', verdict: 'reject', run_id: null, cost_usd: 0.01 }],
    final: { outcome: 'skipped' as const, code: 'exhausted', step: 'initial' as const, reason: 'x' },
  };
  await plans.updateSlot(id, { fallback });
  const s = await plans.getSlot(id);
  assert.deepEqual(s?.fallback, fallback);
  await pool.query(`DELETE FROM editor_slots WHERE id = $1`, [id]);
});

test('postOnce: one item per kind and resource-day, even against the unique index', { skip }, async () => {
  const alerts: string[] = [];
  const inbox = new OwnerInbox(pool, async (t) => { alerts.push(t); });
  const item = { kind: 'dark_day', title: 'Silent day', body: 'b', severity: 'action' as const, ...dailyRef(REF, '2026-10-01') };
  assert.ok(await inbox.postOnce(item));
  assert.equal(await inbox.postOnce(item), null);
  assert.equal(alerts.length, 1, 'no second Telegram alert either');
  // A raw duplicate insert hits the unique index (migration 076).
  await assert.rejects(pool.query(`INSERT INTO agent_inbox (kind, title, ref_type, ref_id) VALUES ('dark_day', 't', 'resource_day', $1)`, [`${REF}|2026-10-01`]), /duplicate key/);
});

test('watch on a fake clock: dark_day and series_missed once per resource per day; the digest plan block', { skip }, async () => {
  await pool.query(`DELETE FROM agent_inbox WHERE ref_id LIKE $1`, [`${REF}|%`]);
  // 11.10 (Kyiv): a series slot with nothing fresh and a critic reject; nothing out.
  await addSlot({ at: '2026-10-11T06:00:00Z', status: 'skipped', error: 'no_fresh_item: no item ≤ 12 h', series: 'Три новини дня' });
  await addSlot({ at: '2026-10-11T09:00:00Z', status: 'skipped', error: 'critic_rejected: reject (grounding 2): x', critic: { verdict: 'reject', notes: 'x' } });
  const inbox = new OwnerInbox(pool);
  const watch = new SilentDaysWatch({ pool, inbox, everyMs: 0 });
  const cards = [makeCard({ channelKey: CH, mode: 'live', postsPerDayMin: 2 })];

  await watch.check(cards, new Date('2026-10-11T10:00:00Z'));     // 13:00 Kyiv: series note only
  await watch.check(cards, new Date('2026-10-11T15:05:00Z'));     // 18:05: dark day
  await watch.check(cards, new Date('2026-10-11T18:00:00Z'));     // 21:00: nothing new
  await addSlot({ at: '2026-10-11T19:00:00Z', status: 'skipped', error: 'critic_rejected: reject', series: 'Три новини дня', critic: { verdict: 'reject' } });
  await watch.check(cards, new Date('2026-10-11T20:00:00Z'));     // 23:00: a second miss, same day — still one note
  const { rows } = await pool.query(`SELECT kind, ref_id, body FROM agent_inbox WHERE ref_id LIKE $1 ORDER BY id`, [`${REF}|%`]);
  assert.deepEqual(rows.map((r) => [r.kind, r.ref_id]), [
    ['series_missed', `${REF}|2026-10-11`], ['dark_day', `${REF}|2026-10-11`],
  ]);
  assert.match(rows[1].body, /Planned today: 2; out: 0; not out by reason: nothing fresh 1, critic 1/);

  // The next day (no plan at all) gets its own dark_day note.
  await watch.check(cards, new Date('2026-10-12T16:00:00Z'));
  await watch.check(cards, new Date('2026-10-12T17:00:00Z'));
  const { rows: n2 } = await pool.query(`SELECT kind, ref_id FROM agent_inbox WHERE ref_id = $1`, [`${REF}|2026-10-12`]);
  assert.deepEqual(n2.map((r) => r.kind), ['dark_day']);

  // MANAGER digest: planned vs out per day, skip reasons, flags.
  const q = (await new SqlQuality(pool).digest([REF], new Date('2026-10-12T16:00:00Z'))).get(REF)!;
  assert.deepEqual(q.plan?.days.map((d) => [d.day, d.planned, d.published, d.skip_reasons]), [['2026-10-11', 3, 0, { nothing_fresh: 1, critic: 2 }]]);
  assert.deepEqual(q.plan?.dark_days, ['2026-10-11']);
  assert.ok(q.flags.includes('dark_day') && q.flags.includes('series_missed'));
});
