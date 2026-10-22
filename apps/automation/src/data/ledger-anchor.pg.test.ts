/**
 * Spec 061 FR-002 / FR-004 against a throwaway Postgres (init.sql + every migration, own database, dropped at the end):
 * migration 094 (idempotent, its down file), reference documents keyed by URL + anchor in the content ledger, the review-3
 * fixture (7 pdr slots on one law URL, different clauses → no `source_already_posted`; the same clause twice → stopped with
 * details), waiting posts, the anchored `content_ledger_record`, and the `strikes` column of source_host_failures.
 * Skipped unless EDITOR_PG_TEST_URL is set. Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { ContentLedger } from './content-ledger';
import { sourceUsedDetails } from './ledger-anchor';
import { createProbeDb, MIGRATIONS_DIR, type ProbeDb } from '../editor/agents/testing/probe-db';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const LAW = 'https://zakon.rada.gov.ua/laws/show/1306-2001-%D0%BF';
const PDR = 'telegram:@pdr061';
let db: ProbeDb;
let pool: Pool;
let ledger: ContentLedger;

before(async () => {
  if (!url) return;
  db = await createProbeDb(url, 'p061_ledger');
  pool = db.pool;
  ledger = new ContentLedger(pool, undefined, () => ['zakon.rada.gov.ua']);
});
after(async () => {
  if (!url) return;
  await db.drop();
});

const up = () => readFileSync(join(MIGRATIONS_DIR, '094_ledger_anchor_host_strikes.sql'), 'utf8');
const down = () => readFileSync(join(MIGRATIONS_DIR, 'down', '094_ledger_anchor_host_strikes.down.sql'), 'utf8');
const use = (ref: string, slotId: string | null = null) => ledger.record(ref, { resourceRef: PDR, origin: 'editor', status: 'published', slotId });

test('094 applies again; the ledger and the host table have the new columns', { skip }, async () => {
  await pool.query(up());
  const { rows } = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name = 'content_ledger' AND column_name = 'anchor') OR (table_name = 'source_host_failures' AND column_name IN ('strikes', 'noted_at'))`);
  assert.deepEqual(rows.map((r) => `${r.table_name}.${r.column_name}`).sort(), ['content_ledger.anchor', 'source_host_failures.noted_at', 'source_host_failures.strikes']);
  const { rows: v } = await pool.query(`SELECT 1 FROM schema_migrations WHERE version = '094_ledger_anchor_host_strikes'`);
  assert.equal(v.length, 1);
});

test('content_anchor_norm / content_ref_anchored: one normal form, from the argument or the fragment', { skip }, async () => {
  const q = async (sql: string, p: unknown[]) => (await pool.query(sql, p)).rows[0].r;
  assert.equal(await q(`SELECT content_anchor_norm($1) AS r`, ['  П.1.10 ']), 'п.1.10');
  assert.equal(await q(`SELECT content_anchor_norm($1) AS r`, ['   ']), null);
  assert.equal((await q(`SELECT content_anchor_norm($1) AS r`, ['x'.repeat(60)])).length, 40);
  assert.equal(await q(`SELECT content_ref_anchored($1, $2) AS r`, [LAW, 'П.1.10']), `${LAW}#п.1.10`);
  assert.equal(await q(`SELECT content_ref_anchored($1, NULL) AS r`, [`${LAW}#п.2.3`]), `${LAW}#п.2.3`, 'the fragment is the anchor when none is given');
  assert.equal(await q(`SELECT content_ref_anchored($1, NULL) AS r`, [LAW]), null);
  assert.equal(await q(`SELECT content_ref_anchored($1, $2) AS r`, ['https://WWW.Zakon.rada.gov.ua/x/?utm_source=a', 'п.1'] ), 'https://zakon.rada.gov.ua/x#п.1', 'the canonical form of the URL, utm dropped');
});

test('review 3 fixture: seven clauses of one law are seven posts; the same clause twice is stopped with details', { skip }, async () => {
  for (let i = 1; i <= 7; i++) {
    const ref = `${LAW}#п.1.${i}`;
    assert.deepEqual(await ledger.check(PDR, ref, { waiting: true }), { used: false }, `п.1.${i} is free before it is posted`);
    assert.equal(await use(ref), true);
  }
  const { rows } = await pool.query(`SELECT source_ref, anchor FROM content_ledger WHERE resource_ref = $1 ORDER BY anchor`, [PDR]);
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.map((r) => r.anchor), ['п.1.1', 'п.1.2', 'п.1.3', 'п.1.4', 'п.1.5', 'п.1.6', 'п.1.7']);
  assert.ok(rows.every((r) => r.source_ref === `${'https://zakon.rada.gov.ua/laws/show/1306-2001-%D0%BF'}#${r.anchor}`));

  const again = await ledger.check(PDR, `${LAW}#П.1.3`, { waiting: true });
  assert.equal(again.used, true, 'the same clause, spelled in capitals, is the same clause');
  assert.equal(again.used && again.anchor, 'п.1.3');
  assert.ok(again.used && again.at instanceof Date);
  const details = again.used ? sourceUsedDetails(LAW, { at: again.at, slotId: again.slotId, status: again.status, anchor: again.anchor }, true) : '';
  assert.match(details, /використано \d{4}-\d{2}-\d{2}/);
  assert.match(details, /\(п\.1\.3\)/);
  assert.deepEqual(await ledger.check(PDR, `${LAW}#п.1.8`, { waiting: true }), { used: false }, 'an eighth clause is free');
});

test('the same clause cannot be recorded twice; it is still one ledger row (UNIQUE on the anchored ref)', { skip }, async () => {
  assert.equal(await use(`${LAW}#п.2.1`), true);
  assert.equal(await use(`${LAW}#П.2.1`), false, 'a repeat moves the row, it adds none');
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM content_ledger WHERE resource_ref = $1 AND anchor = 'п.2.1'`, [PDR]);
  assert.equal(rows[0].n, 1);
  await assert.rejects(
    pool.query(`INSERT INTO content_ledger (resource_ref, source_ref, origin, status, anchor) VALUES ($1, $2, 'editor', 'published', 'x')`, [PDR, 'https://zakon.rada.gov.ua/y#z']),
    /content_ledger_anchor_ref/, 'a row whose anchor is not the end of its ref is refused');
});

test('a reusable-host source without an anchor is allowed, whatever plain rows exist; another host stays URL-level', { skip }, async () => {
  await pool.query(`INSERT INTO content_ledger (resource_ref, source_ref, origin, status) VALUES ($1, $2, 'editor', 'published')`, [PDR, 'https://zakon.rada.gov.ua/laws/show/1306-2001-%D0%BF']);
  assert.deepEqual(await ledger.check(PDR, LAW, { waiting: true }), { used: false }, 'the old plain row of the law blocks nothing');
  assert.deepEqual(await ledger.check(PDR, `${LAW}#п.9.9`), { used: false });
  await use('https://nasa.gov/ring#top');
  const v = await ledger.check(PDR, 'https://nasa.gov/ring');
  assert.equal(v.used, true, 'a news URL is still one post, whatever its fragment');
  const { rows } = await pool.query(`SELECT anchor FROM content_ledger WHERE resource_ref = $1 AND source_ref = 'https://nasa.gov/ring'`, [PDR]);
  assert.equal(rows[0].anchor, null);
});

test('a waiting (approval) post holds its clause; a shadow row holds it for 7 days; an error row is only for that clause', { skip }, async () => {
  const ch = '@pdr061w';
  await pool.query(`INSERT INTO editor_channels (channel_key, mode) VALUES ($1, 'approve') ON CONFLICT DO NOTHING`, [ch]);
  const { rows: p } = await pool.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ($1, current_date) RETURNING id`, [ch]);
  const { rows: s } = await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, post_spec)
     VALUES ($1, $2, now(), 'text', 't', 'awaiting_approval', $3) RETURNING id`,
    [p[0].id, ch, JSON.stringify({ source: { url: LAW, anchor: 'П.5.5' } })]);
  const w = await ledger.check(ch, `${LAW}#п.5.5`, { waiting: true });
  assert.equal(w.used && w.status, 'waiting');
  assert.equal(w.used && w.slotId, s[0].id);
  assert.deepEqual(await ledger.check(ch, `${LAW}#п.5.6`, { waiting: true }), { used: false });
  assert.deepEqual(await ledger.check(ch, `${LAW}#п.5.5`), { used: false }, 'without `waiting` only the ledger rows count');
  // The slot's own re-check leaves it out.
  assert.deepEqual(await ledger.check(ch, `${LAW}#п.5.5`, { waiting: true, excludeSlotId: s[0].id }), { used: false });

  await ledger.record(`${LAW}#п.6.1`, { resourceRef: ch, origin: 'editor', status: 'shadowed' });
  assert.equal((await ledger.check(ch, `${LAW}#п.6.1`)).used, true);
  await ledger.record(`${LAW}#п.6.2`, { resourceRef: ch, origin: 'editor', status: 'error', note: 'dead clause' });
  assert.equal((await ledger.check(ch, `${LAW}#п.6.2`)).used, true);
  assert.equal((await ledger.check(ch, `${LAW}#п.6.3`)).used, false, 'an error on one clause does not poison the law');
});

test('content_ledger_record is untouched: the 9-argument callers (the 060 triggers) keep working, also after a rerun of 060', { skip }, async () => {
  await pool.query(readFileSync(join(MIGRATIONS_DIR, '060_content_ledger.sql'), 'utf8'));
  const { rows } = await pool.query(`SELECT content_ledger_record($1, $2, 'strategy', 'published', NULL, NULL, NULL, NULL, 'n') AS added`, [PDR, 'https://old.example/p?utm_source=x']);
  assert.equal(rows[0].added, true);
  const { rows: r } = await pool.query(`SELECT source_ref, anchor FROM content_ledger WHERE resource_ref = $1 AND source_ref = 'https://old.example/p'`, [PDR]);
  assert.deepEqual(r[0], { source_ref: 'https://old.example/p', anchor: null });
});

test('source_host_failures has strikes (kept) and noted_at', { skip }, async () => {
  await pool.query(`INSERT INTO source_host_failures (host, reason, status_code, blocked_until, strikes) VALUES ('p061.example', 'refused', 403, now() - interval '1 hour', 2)`);
  const { rows } = await pool.query(`SELECT strikes, failures, noted_at FROM source_host_failures WHERE host = 'p061.example'`);
  assert.deepEqual(rows[0], { strikes: 2, failures: 1, noted_at: null });
  await pool.query(`DELETE FROM source_host_failures WHERE host = 'p061.example'`);
});

test('094 down: anchored rows go, plain rows stay; up again works', { skip }, async () => {
  await pool.query(down());
  const { rows: cols } = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'content_ledger' AND column_name = 'anchor'`);
  assert.equal(cols.length, 0);
  const { rows: left } = await pool.query(`SELECT COUNT(*)::int AS n FROM content_ledger WHERE resource_ref = $1 AND source_ref LIKE '%#%'`, [PDR]);
  assert.equal(left[0].n, 0, 'no anchored ref survives the down');
  const { rows: plain } = await pool.query(`SELECT 1 FROM content_ledger WHERE resource_ref = $1 AND source_ref = 'https://old.example/p'`, [PDR]);
  assert.equal(plain.length, 1);
  await pool.query(up());
  const { rows: back } = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'source_host_failures' AND column_name = 'strikes'`);
  assert.equal(back.length, 1);
});
