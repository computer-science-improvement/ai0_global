/**
 * Spec 090 FR-003 against a throwaway Postgres (init.sql + every migration, own database): pending cards past their TTL are
 * applied or dropped by the owner-gate registry, with a decision row, an `auto:silence` mark and a working undo.
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { createProbeDb, type ProbeDb } from './testing/probe-db';
import { DataStore } from '../../data/data-store';
import { AutonomyDecisionsRepository, AutonomyUndo } from '../autonomy/autonomy-decisions.repository';
import { PgSourceProbes } from '../sources/source-probes.repository';
import { changeSourceSilence, undoSourceChange } from '../sources/source-silence';
import { applySourceChangeAction } from '../sources/source-tools';
import { applyDataSchemaSuggestion, dataSchemaSilence, undoDataSchemaEdit } from '../tools/data-tools';
import { APPLIED_BY_SILENCE, PendingActionsRepository, PendingActionsService } from './pending-actions';
import type { CardSource } from '../card';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const K = 'p090a_quotes';
const CH = '@p090a_chan';
let db: ProbeDb;
let pool: Pool;
let store: DataStore;
let sources: CardSource[] = [];
let envMap: Record<string, string> = {};
let svc: PendingActionsService;
let decisions: AutonomyDecisionsRepository;
let undo: AutonomyUndo;

const card = () => ({ channelKey: CH, sources }) as any;
const channels = { get: async () => card(), upsert: async (_k: string, p: { sources: CardSource[] }) => { sources = p.sources; } };

before(async () => {
  if (!url) return;
  db = await createProbeDb(url, 'p090a_pending');
  pool = db.pool;
  store = new DataStore(pool);
  await store.createSchema({
    key: K, title: 'Test quotes', description: 'Short quotes', entity: 'quote',
    fields: [{ name: 'text', type: 'long_text', description: 'The quote', required: true }, { name: 'author', type: 'text', description: 'Who said it' }],
    roles: { title: 'author', body: 'text' }, dedup_key: ['text'], language: 'uk', default_license: 'public_domain',
    reuse_policy: { kind: 'never' }, suitable_for: 'literature channels', contains_personal_data: false, status: 'active',
  }, 'pgtest');
  decisions = new AutonomyDecisionsRepository(pool);
  undo = new AutonomyUndo(decisions);
  svc = new PendingActionsService(new PendingActionsRepository(pool), undefined, { env: (k) => envMap[k], decisions });
  svc.register('edit_data_schema', (p) => applyDataSchemaSuggestion(store, p));
  svc.register('change_source', (p) => applySourceChangeAction(p, { channels, upsert: channels.upsert }));
  svc.register('set_network_mode', async () => ({ ok: true }));
  svc.registerSilence('edit_data_schema', dataSchemaSilence(store));
  svc.registerSilence('change_source', changeSourceSilence({ probes: new PgSourceProbes(pool), channels }));
  undo.register('edit_data_schema', (u, c) => undoDataSchemaEdit(store, u, c.by));
  undo.register('change_source', (u) => undoSourceChange(u, { channels, upsert: channels.upsert }));
});
after(async () => {
  if (!url) return;
  await db.drop();
});
beforeEach(async () => {
  if (!url) return;
  envMap = {};
  sources = [{ id: 'old', kind: 'rss', ref: 'https://old.example.com/feed' }];
  await pool.query(`DELETE FROM pending_actions`);
  await pool.query(`DELETE FROM autonomy_decisions`);
  await pool.query(`DELETE FROM source_probes`);
  await pool.query(`UPDATE data_schemas SET description = 'Short quotes' WHERE key = $1`, [K]);
});

const old = (id: string, hours = 25) => pool.query(`UPDATE pending_actions SET created_at = now() - ($2 || ' hours')::interval WHERE id = $1`, [id, String(hours)]);
const schemaCard = (chatId: string | null = null, oldText = 'Short quotes', newText = 'Short quotes by Ukrainian writers') =>
  svc.propose({ chatId, kind: 'edit_data_schema', payload: { dataset: K, target: 'description', old_text: oldText, new_text: newText, evidence: 'All rows are by Ukrainian writers.' }, summary: 'Better description' });
const sourceCard = (action: string, extra: Record<string, unknown> = {}, chatId: string | null = null) =>
  svc.propose({ chatId, kind: 'change_source', payload: { channelKey: CH, action, reason: 'test', ...extra }, summary: `source ${action}` });
const probe = (ref: string, o: { ok?: boolean; hoursAgo?: number } = {}) => pool.query(
  `INSERT INTO source_probes (url, host, ok, failure_class, status, kind, items, sample_titles, detail, via_proxy, checked_at)
   VALUES ($1, 'h', $2, $3, 200, 'rss', 5, '[]'::jsonb, 'ok', false, now() - ($4 || ' hours')::interval)`,
  [ref, o.ok ?? true, o.ok === false ? 'empty' : null, String(o.hoursAgo ?? 1)]);
const status = async (id: string) => (await svc.get(id))!;

test('an unanswered non-chat edit_data_schema card is applied on silence, logged, and the undo restores the description', { skip }, async () => {
  const a = await schemaCard();
  await old(a.id);
  assert.equal(await svc.expireOld(new Date()), 1);
  const done = await status(a.id);
  assert.equal(done.status, 'applied');
  assert.equal((done.result as any).applied_by, APPLIED_BY_SILENCE);
  assert.equal((await store.requireSchema(K)).description, 'Short quotes by Ukrainian writers');
  const [d] = await decisions.list();
  assert.deepEqual([d.gate, d.refType, d.refId, d.action], ['pending_action:edit_data_schema', 'pending_action', a.id, 'applied']);
  assert.equal(d.undo?.kind, 'edit_data_schema');
  const r = await undo.undo(d.id, 'owner');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await store.requireSchema(K)).description, 'Short quotes');
});

test('a card still inside its TTL is left alone; PENDING_ACTION_TTL_HOURS is read live', { skip }, async () => {
  const a = await schemaCard();
  await old(a.id, 30);
  envMap.PENDING_ACTION_TTL_HOURS = '48';
  assert.equal(await svc.expireOld(new Date()), 0);
  assert.equal((await status(a.id)).status, 'pending');
  envMap.PENDING_ACTION_TTL_HOURS = '24';
  assert.equal(await svc.expireOld(new Date()), 1);
});

test('a chat card is dropped (expired), with a dropped decision', { skip }, async () => {
  const chat = (await pool.query(`INSERT INTO editor_chats DEFAULT VALUES RETURNING id`)).rows[0].id;
  const a = await schemaCard(chat);
  await old(a.id);
  await svc.expireOld(new Date());
  assert.equal((await status(a.id)).status, 'expired');
  const [d] = await decisions.list();
  assert.deepEqual([d.gate, d.action, d.undo], ['pending_action:chat', 'dropped', null]);
  assert.equal((await store.requireSchema(K)).description, 'Short quotes', 'nothing was written');
});

test('other kinds expire (drop); OWNER_SILENCE=wait drops the applicable ones too', { skip }, async () => {
  const other = await svc.propose({ chatId: null, kind: 'set_network_mode', payload: {}, summary: 'mode' });
  const a = await schemaCard();
  envMap.OWNER_SILENCE = 'wait';
  await old(other.id);
  await old(a.id);
  assert.equal(await svc.expireOld(new Date()), 2);
  assert.equal((await status(other.id)).status, 'expired');
  assert.equal((await status(a.id)).status, 'expired');
  assert.deepEqual((await decisions.list()).map((d) => d.action), ['dropped', 'dropped']);
});

test('a failed apply on silence marks the card failed and logs a failed decision', { skip }, async () => {
  const a = await schemaCard(null, 'stale text that is not current');
  await old(a.id);
  await svc.expireOld(new Date());
  const done = await status(a.id);
  assert.equal(done.status, 'failed');
  assert.match(done.error ?? '', /stale/);
  const [d] = await decisions.list();
  assert.equal(d.action, 'failed');
});

test('change_source: an add with a fresh ok probe is applied; the undo removes the source again', { skip }, async () => {
  const ref = 'https://new.example.com/feed';
  await probe(ref);
  const a = await sourceCard('add', { source: { kind: 'rss', ref } });
  await old(a.id);
  await svc.expireOld(new Date());
  assert.equal((await status(a.id)).status, 'applied');
  assert.deepEqual(sources.map((s) => s.ref), ['https://old.example.com/feed', ref]);
  const [d] = await decisions.list();
  assert.equal(d.action, 'applied');
  assert.equal((await undo.undo(d.id, 'owner')).ok, true);
  assert.deepEqual(sources.map((s) => s.ref), ['https://old.example.com/feed']);
});

test('change_source: a replace with a fresh probe is applied; the undo puts the old source back', { skip }, async () => {
  const ref = 'https://new.example.com/feed';
  await probe(ref);
  const a = await sourceCard('replace', { sourceId: 'old', source: { kind: 'rss', ref } });
  await old(a.id);
  await svc.expireOld(new Date());
  assert.deepEqual(sources.map((s) => s.ref), [ref]);
  const [d] = await decisions.list();
  assert.equal((await undo.undo(d.id, 'owner')).ok, true);
  assert.deepEqual(sources, [{ id: 'old', kind: 'rss', ref: 'https://old.example.com/feed' }]);
});

test('change_source: a failed, stale or missing probe drops the card; so does a removal and a non-feed source', { skip }, async () => {
  const bad = 'https://bad.example.com/feed';
  const stale = 'https://stale.example.com/feed';
  const none = 'https://none.example.com/feed';
  await probe(bad, { ok: false });
  await probe(stale, { hoursAgo: 8 });
  const cards = [
    await sourceCard('add', { source: { kind: 'rss', ref: bad } }),
    await sourceCard('add', { source: { kind: 'rss', ref: stale } }),
    await sourceCard('add', { source: { kind: 'rss', ref: none } }),
    await sourceCard('remove', { sourceId: 'old' }),
    await sourceCard('add', { source: { kind: 'api', ref: 'some_api' } }),
  ];
  for (const c of cards) await old(c.id);
  await svc.expireOld(new Date());
  for (const c of cards) assert.equal((await status(c.id)).status, 'expired', c.summary);
  assert.deepEqual(sources.map((s) => s.ref), ['https://old.example.com/feed'], 'no source was touched');
  assert.ok((await decisions.list()).every((d) => d.action === 'dropped'));
});

test('an Apply click on an overdue card is settled by the registry too', { skip }, async () => {
  const a = await schemaCard();
  await old(a.id);
  const out = await svc.apply(a.id);
  assert.equal(out.status, 'applied');
  assert.equal((out.result as any).applied_by, APPLIED_BY_SILENCE);
});
