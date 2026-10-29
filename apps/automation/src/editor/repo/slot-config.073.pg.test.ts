/**
 * Spec 073 T12 on a throwaway Postgres (init.sql + every migration):
 *  - `EditorPlansRepository.patchSlotConfig` patches a RUNNING slot (format, source hints), appends the note to `fallback.repairs`
 *    and returns the patched slot; any other status gets null and no write (A7, A32);
 *  - `ScheduleService.slotConfigContext` through the real ports reads and never writes: a cycle dataset whose round is done keeps
 *    its round (`data_reuse_rounds` unchanged), while `executorContext` (a run) rolls it (I1).
 * Skipped unless EDITOR_PG_TEST_URL is set (needs CREATEDB). Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { EditorPlansRepository } from './editor-plans.repository';
import { ScheduleService } from '../schedule/schedule.service';
import { nextRowPort, unpostedPort } from '../schedule/next-row';
import { ContentLedger } from '../../data/content-ledger';
import { DataStore } from '../../data/data-store';
import type { ReusePolicy } from '../../data/data.types';
import { checkSlotConfig } from '../readiness/slot-config';
import { makeCard } from '../post/testing/fixtures';
import { createMigratedDb, type FreshDb } from '../sysadmin/testing/fresh-db';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pgt073_cfg';
const REF = `telegram:${CH}`;
let db: FreshDb;
let pool: Pool;
let repo: EditorPlansRepository;
let planId: string;
let store: DataStore;
let ledger: ContentLedger;

before(async () => {
  if (!url) return;
  db = await createMigratedDb(url, 'c073');
  pool = db.pool;
  repo = new EditorPlansRepository(pool);
  store = new DataStore(pool);
  ledger = new ContentLedger(pool);
  await pool.query(`INSERT INTO editor_channels (channel_key, mode, formats) VALUES ($1, 'live', '{"text":1,"quiz":0.2}')`, [CH]);
  planId = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date, rationale, status) VALUES ($1, '2026-10-29', 'test', 'active') RETURNING id`, [CH])).rows[0].id;
});
after(async () => { if (db) await db.drop(); });

async function slot(status: string, over: { hints?: string[]; fallback?: unknown } = {}): Promise<string> {
  return (await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, kind, format, topic, source_hints, status, series_name, fallback)
     VALUES ($1, $2, now(), 'content', 'text', 'Тема', $3, $4, 'Prompt', $5) RETURNING id`,
    [planId, CH, JSON.stringify(over.hints ?? ['https://prompthero.com/x']), status, over.fallback ? JSON.stringify(over.fallback) : null])).rows[0].id;
}
const raw = async (id: string) => (await pool.query(`SELECT format, source_hints, fallback, status FROM editor_slots WHERE id = $1`, [id])).rows[0];

test('patchSlotConfig: a running slot gets the format and the hints, the note lands in fallback.repairs, the patched slot comes back', { skip }, async () => {
  const id = await slot('running');
  const at = new Date('2026-10-29T09:00:00Z');
  const out = await repo.patchSlotConfig(id, { format: 'photo', sourceHints: ['series:Prompt', 'data://prompts/503'], note: 'config_format_mismatch: text → photo' }, at);
  assert.ok(out);
  assert.equal(out!.format, 'photo');
  assert.deepEqual(out!.sourceHints, ['series:Prompt', 'data://prompts/503']);
  assert.deepEqual(out!.fallback, { steps: [], final: null, repairs: [{ at: at.toISOString(), note: 'config_format_mismatch: text → photo' }] });
  const row = await raw(id);
  assert.equal(row.format, 'photo');
  assert.equal(row.status, 'running', 'the status is untouched');
});

test('patchSlotConfig: only the given fields change; a second patch appends; existing steps and final survive', { skip }, async () => {
  const id = await slot('running', { hints: ['series:Prompt'], fallback: { steps: [{ step: 'initial', outcome: 'lint' }], final: null } });
  await repo.patchSlotConfig(id, { format: 'photo', note: 'config_format_mismatch: text → photo' }, new Date('2026-10-29T09:00:00Z'));
  const second = await repo.patchSlotConfig(id, { sourceHints: ['series:Prompt', 'data://prompts/1'], note: 'config_source_mismatch: x' }, new Date('2026-10-29T09:01:00Z'));
  assert.deepEqual(second!.sourceHints, ['series:Prompt', 'data://prompts/1']);
  assert.equal(second!.format, 'photo', 'the first patch stays');
  assert.deepEqual((second!.fallback as any).steps, [{ step: 'initial', outcome: 'lint' }]);
  assert.deepEqual((second!.fallback as any).repairs.map((r: any) => r.note), ['config_format_mismatch: text → photo', 'config_source_mismatch: x']);
  // Hints alone leave the format; format alone leaves the hints.
  const third = await repo.patchSlotConfig(id, { note: 'only a note' });
  assert.equal(third!.format, 'photo');
  assert.deepEqual(third!.sourceHints, ['series:Prompt', 'data://prompts/1']);
});

test('patchSlotConfig: a slot that is not running gets null and nothing is written', { skip }, async () => {
  for (const status of ['planned', 'published', 'skipped', 'failed', 'shadowed', 'awaiting_approval']) {
    const id = await slot(status);
    assert.equal(await repo.patchSlotConfig(id, { format: 'photo', sourceHints: ['series:Prompt'], note: 'x' }), null, status);
    const row = await raw(id);
    assert.equal(row.format, 'text', status);
    assert.deepEqual(row.source_hints, ['https://prompthero.com/x'], status);
    assert.equal(row.fallback, null, status);
  }
  assert.equal(await repo.patchSlotConfig('00000000-0000-0000-0000-000000000000', { format: 'photo', note: 'x' }), null, 'no such slot');
});

// ── slotConfigContext reads, never writes (I1) ───────────────────────────────────────────────

let seq = 0;
async function dataset(policy: ReusePolicy, n: number): Promise<{ key: string; ids: string[] }> {
  const key = `pgt073_ds${++seq}`;
  await store.createSchema({
    key, title: key, description: 'config context test', entity: 'item',
    fields: [{ name: 'num', type: 'int', description: 'Number', required: true }],
    roles: { title: 'num' }, dedup_key: ['num'], language: 'uk', default_license: 'own', reuse_policy: policy,
    suitable_for: 'tests', contains_personal_data: false, status: 'active',
  } as any, 'pgtest');
  if (n) await store.upsert(key, Array.from({ length: n }, (_, i) => ({ num: i + 1 })));
  const { rows } = await pool.query(`SELECT d.id::text AS id FROM data_items d JOIN data_schemas s ON s.id = d.schema_id WHERE s.key = $1 ORDER BY d.id`, [key]);
  return { key, ids: rows.map((r) => r.id) };
}
const roundsOf = async () => (await pool.query(`SELECT s.key, r.round FROM data_reuse_rounds r JOIN data_schemas s ON s.id = r.schema_id ORDER BY s.key, r.resource_ref`)).rows;

function scheduleOn(key: string) {
  const series = {
    name: 'Prompt', brief: 'A prompt with its picture', format: 'text', cadence: 'daily 19:00', resource_ref: REF, active: true,
    source: { kind: 'library', table: key }, source_mode: 'required',
  };
  return new ScheduleService({
    pool,
    rules: { get: async () => null, activeFor: async () => [] } as any,
    network: { activePlaybook: async () => ({ body: { series: [series] } }) } as any,
    agents: { findTop: async () => ({ id: 'o1', handle: 'cfg' }) } as any,
    card: async () => null, plans: {} as any, inbox: { post: async () => {} } as any,
    sourceCatalog: async () => ({ tables: [key], feeds: [], entities: { [key]: 'item' } }),
    unposted: unpostedPort(pool),
    nextRow: nextRowPort(pool),
  } as any);
}
const cfgSlot = (): any => ({ id: 's1', channelKey: CH, resourceRef: REF, seriesName: 'Prompt', sourceHints: [], format: 'text', scheduledAt: new Date() });

test('I1 slotConfigContext leaves data_reuse_rounds unchanged on a cycle dataset whose round is done; executorContext (a run) rolls it', { skip }, async () => {
  const { key, ids } = await dataset({ kind: 'cycle', order: 'sequential' }, 2);
  // Row 1 is posted; row 2 is hidden afterwards, so nothing is open and no ledger write has rolled the round yet.
  await ledger.record(`data://${key}/${ids[0]}`, { resourceRef: REF, origin: 'editor', status: 'published' });
  await pool.query(`UPDATE data_items SET status = 'hidden' WHERE id = $1::bigint`, [ids[1]]);
  const before = await roundsOf();
  const svc = scheduleOn(key);
  const ctx = await svc.slotConfigContext(makeCard({ channelKey: CH }), cfgSlot());
  assert.deepEqual(await roundsOf(), before, 'the read-only context started no round');
  assert.equal(ctx?.material, null, 'a done round with postable rows is unknown, not «empty»: the run will roll it');
  assert.equal(ctx?.nextRow, null);
  assert.deepEqual(checkSlotConfig({ channelKey: CH, resourceRef: REF, format: 'text', seriesName: 'Prompt', sourceHints: [] }, ctx!).map((p) => p.code), [], 'no false preflight_no_material');
  // The run rolls the round and takes the first row.
  const run = await svc.executorContext(cfgSlot());
  assert.equal(run.nextRow, `data://${key}/${ids[0]}`);
  assert.deepEqual((await roundsOf()).filter((r) => r.key === key), [{ key, round: 2 }]);
  // After the roll the context sees the new round's row, and still writes nothing.
  const afterRoll = await roundsOf();
  const again = await svc.slotConfigContext(makeCard({ channelKey: CH }), cfgSlot());
  assert.equal(again?.material, 'ok');
  assert.equal(again?.nextRow, `data://${key}/${ids[0]}`);
  assert.deepEqual(await roundsOf(), afterRoll);
});

test('I1 a dataset with no postable row at all reads as empty, and the context writes nothing for it either', { skip }, async () => {
  const { key } = await dataset({ kind: 'cycle', order: 'sequential' }, 0);
  const before = await roundsOf();
  const ctx = await scheduleOn(key).slotConfigContext(makeCard({ channelKey: CH }), cfgSlot());
  assert.equal(ctx?.material, 'empty');
  assert.deepEqual(await roundsOf(), before);
});

test('I1 a plain dataset (reuse never): unposted rows are the open ones, empty when every row is used', { skip }, async () => {
  const { key, ids } = await dataset({ kind: 'never' }, 2);
  const svc = scheduleOn(key);
  assert.equal((await svc.slotConfigContext(makeCard({ channelKey: CH }), cfgSlot()))?.material, 'ok');
  for (const id of ids) await ledger.record(`data://${key}/${id}`, { resourceRef: REF, origin: 'editor', status: 'published' });
  assert.equal((await svc.slotConfigContext(makeCard({ channelKey: CH }), cfgSlot()))?.material, 'empty');
});
