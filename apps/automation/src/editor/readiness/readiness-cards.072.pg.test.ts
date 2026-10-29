/**
 * Spec 072 T7 against a throwaway database of its own (every migration applied; see testing/pg-db.ts): the readiness card's query
 * reads the stored rows, joins the card and the sweep set, and tells whether a launch is open. Skipped unless EDITOR_PG_TEST_URL
 * is set. Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import type { Finding } from '../sysadmin/audit.types';
import { makeCard } from '../post/testing/fixtures';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { readinessSource } from './readiness-cards';
import { ReadinessRepository } from './readiness.repository';
import { mkF } from './testing/fake-readiness';
import { scratchDb, type ScratchDb } from './testing/pg-db';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;

const STAMP = new Date('2026-10-20T10:00:00.000Z');
let db: ScratchDb;
let pool: Pool;
let channels: EditorChannelsRepository;
let repo: ReadinessRepository;

const err = (key: string, code: string, id: string): Finding => {
  const f = mkF(code, 'error', { id });
  return { ...f, subject: { ...f.subject, channel: key, label: `${code}:${id}` } };
};
const card = (channelKey: string, mode: 'off' | 'shadow' | 'approve' | 'live') =>
  channels.upsert(makeCard({ channelKey, mode, formats: { text: 1 }, hashtags: [], hashtagMin: 0, hashtagMax: 3, toolsAllow: null }));
/** A stored row with the given errors, stamped with all of them. */
async function store(key: string, findings: Finding[], o: { stamp?: boolean; blockers?: number } = {}) {
  await repo.upsert({
    channelKey: key, findings, blockers: o.blockers ?? findings.filter((f) => f.severity === 'error').length, warnings: 0, configHash: 'h', checkedAt: STAMP,
    ...(o.stamp === false ? {} : { notifiedBlockers: findings.filter((f) => f.severity === 'error').map((f) => f.key).sort(), notifiedAt: STAMP }),
  });
}
const source = () => readinessSource({
  pool, readiness: { fix: async () => { throw new Error('not used'); }, recheck: async () => { throw new Error('not used'); } } as any,
  agentOf: async (k) => (k === '@Fx072CardA' ? 'card_a_orch' : null),
});

before(async () => {
  if (!url) return;
  db = await scratchDb(url, 'rdcard');
  pool = db.pool;
  channels = new EditorChannelsRepository(pool);
  repo = new ReadinessRepository(pool);
});
after(async () => { if (db) await db.drop(); });

test('the card query returns the stamped rows of the sweep set, with the agent\'s path, and nothing else', { skip }, async () => {
  const a = err('@Fx072CardA', 'dataset_without_series', 'a');
  const b = err('@Fx072CardA', 'series_source_contradicted', 'b');
  await card('@Fx072CardA', 'approve');
  await store('@Fx072CardA', [a, b]);
  await card('@Fx072CardLive', 'live');
  await store('@Fx072CardLive', [err('@Fx072CardLive', 'config_conflict', 'c')]);
  // Not in the sweep set, not stamped, no blockers left: none of them is waiting.
  await card('@Fx072CardShadow', 'shadow');
  await store('@Fx072CardShadow', [err('@Fx072CardShadow', 'config_conflict', 'd')]);
  await card('@Fx072CardQuiet', 'approve');
  await store('@Fx072CardQuiet', [err('@Fx072CardQuiet', 'config_conflict', 'e')], { stamp: false });
  await card('@Fx072CardClean', 'approve');
  await store('@Fx072CardClean', [], { blockers: 0 });
  await pool.query(`UPDATE channel_readiness SET notified_blockers = '["x"]'::jsonb, notified_at = $2 WHERE channel_key = $1`, ['@Fx072CardClean', STAMP]);

  const items = await source().waiting(new Date());
  assert.deepEqual(items.map((i) => i.title), ['@Fx072CardA: 2 блокери готовності', '@Fx072CardLive: 1 блокер готовності']);
  const [first, second] = items;
  assert.equal(first.path, '/app/agents/card_a_orch?tab=overview&readiness=1');
  assert.equal(second.path, '/app/editor/%40Fx072CardLive', 'no agent: the editor page');
  assert.match(first.refId, /^@Fx072CardA\|[0-9a-f]{8}\|20261020$/);
  assert.equal(first.since.toISOString(), STAMP.toISOString());
});

test('the card query tells an open launch: with one, bot_not_admin is the launch card\'s and not named here', { skip }, async () => {
  const key = '@Fx072CardLaunch';
  await card(key, 'shadow');
  await store(key, [err(key, 'dataset_without_series', 'a'), err(key, 'bot_not_admin', 'bot')]);
  const titles = async () => (await source().waiting(new Date())).filter((i) => i.refId.startsWith(`${key}|`)).map((i) => i.title);
  assert.deepEqual(await titles(), [], 'a shadow card with no launch is outside the sweep set');
  await pool.query(`INSERT INTO channel_launches (channel_key, target_ref, brief, status) VALUES ($1, $2, 'brief', 'running')`, [key, `telegram:${key}`]);
  assert.deepEqual(await titles(), [`${key}: 1 блокер готовності`]);
  await pool.query(`UPDATE channel_launches SET status = 'graduated' WHERE channel_key = $1`, [key]);
  assert.deepEqual(await titles(), [], 'a graduated launch is not open');
});
