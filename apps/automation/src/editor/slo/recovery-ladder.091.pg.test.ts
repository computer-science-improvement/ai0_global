/**
 * Spec 091 FR-004 / FR-005 queries against a throwaway Postgres (all migrations applied): the series with runway, the probed
 * sources, the evergreen counter (written posts, ladder runs and the controller's own slots), the dark flag, and the
 * 14-day published formats and hosts. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { createProbeDb, type ProbeDb } from '../agents/testing/probe-db';
import { DataStore } from '../../data/data-store';
import { ContentLedger } from '../../data/content-ledger';
import { NetworkRepository } from '../network/network.repository';
import { PlaybookSchema } from '../network/playbook';
import { PgSourceProbes } from '../sources/source-probes.repository';
import { makeCard } from '../post/testing/fixtures';
import { PgLadderStore, RecoveryLadder } from './recovery-ladder';
import { recentPublished } from './dark-recovery';
import type { ClosedSlot } from './types';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@p091b_ch';
const RR = `telegram:${CH}`;
const FULL = 'p091b_full';
const EMPTY = 'p091b_empty';
const NOW = new Date('2026-11-07T12:00:00Z');   // 14:00 Kyiv, day 2026-11-07
let db: ProbeDb;
let pool: Pool;
let planId: string;

const card = (o: Record<string, unknown> = {}) => makeCard({ channelKey: CH, timezone: 'Europe/Kyiv', ...o });

async function slot(o: { status: string; at: string; format?: string; spec?: unknown; fallback?: unknown; slo?: unknown }) {
  await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, kind, format, topic, status, post_spec, fallback, slo)
     VALUES ($1, $2, $3, 'content', $4, 'Тема', $5, $6, $7, $8)`,
    [planId, CH, o.at, o.format ?? 'text', o.status, o.spec ? JSON.stringify(o.spec) : null, o.fallback ? JSON.stringify(o.fallback) : null, o.slo ? JSON.stringify(o.slo) : null]);
}

before(async () => {
  if (!url) return;
  db = await createProbeDb(url, 'p091b_ladder');
  pool = db.pool;
  const store = new DataStore(pool);
  for (const key of [FULL, EMPTY]) {
    await store.createSchema({
      key, title: key, description: 'tips', entity: 'tip', fields: [{ name: 'text', type: 'text', description: 'The tip', required: true }],
      roles: { title: 'text' }, dedup_key: ['text'], language: 'uk', default_license: 'own', reuse_policy: { kind: 'never' },
      suitable_for: 'food channels', contains_personal_data: false, status: 'active',
    }, 'pgtest');
  }
  await store.upsert(FULL, Array.from({ length: 6 }, (_, i) => ({ text: `Порада ${i}` })));
  await store.upsert(EMPTY, [{ text: 'Остання' }]);
  const { rows } = await pool.query(`SELECT d.id FROM data_items d JOIN data_schemas s ON s.id = d.schema_id WHERE s.key = $1`, [EMPTY]);
  await new ContentLedger(pool).record(`data://${EMPTY}/${rows[0].id}`, { resourceRef: RR, origin: 'editor', status: 'published', usedAt: new Date(Date.now() - 86_400_000) });
  const agentId = (await pool.query(
    `INSERT INTO agents (kind, scope, scope_id, name, handle, mode) VALUES ('orchestrator', 'resource', $1, 'Tips', 'p091b_orch', 'shadow') RETURNING id`, [RR])).rows[0].id;
  const body = PlaybookSchema.parse({
    platforms: [{ resource_ref: RR, role: 'core', formats: { text: 1 }, per_day: { min: 1, max: 4 } }],
    series: [
      { name: 'Повна серія', cadence: 'daily@10:00', resource_ref: RR, format: 'text', brief: 'Порада з повного датасету', source: { kind: 'library', table: FULL } },
      { name: 'Порожня серія', cadence: 'daily@12:00', resource_ref: RR, format: 'text', brief: 'Порада з вичерпаного датасету', source: { kind: 'library', table: EMPTY } },
      { name: 'Призупинена', cadence: 'daily@14:00', resource_ref: RR, format: 'text', brief: 'Порада, серію призупинено', source: { kind: 'library', table: FULL } },
      { name: 'Без датасету', cadence: 'daily@16:00', resource_ref: RR, format: 'text', brief: 'Вільна серія без бібліотеки', source: { kind: 'free' } },
    ],
  });
  await new NetworkRepository(pool).insertPlaybook({ agentId, status: 'active', brief: null, body, rationale: 'seed', createdBy: 'owner' });
  await pool.query(`INSERT INTO series_pauses (channel_key, series_key, label, cause) VALUES ($1, 'series:Призупинена', 'Призупинена', 'no_material')`, [CH]);
  await pool.query(`INSERT INTO editor_channels (channel_key, mode) VALUES ($1, 'live')`, [CH]);
  planId = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date, rationale, status) VALUES ($1, '2026-11-07', 'r', 'active') RETURNING id`, [CH])).rows[0].id;
});
after(async () => { if (url) await db.drop(); });

test('seriesWithRunway: library series with unposted rows only; exhausted, paused and non-library series are left out', { skip }, async () => {
  const s = await new PgLadderStore(pool).seriesWithRunway(CH);
  assert.deepEqual(s.map((x) => x.name), ['Повна серія']);
  assert.equal(s[0].unposted, 6);
  assert.equal(s[0].dataset, FULL);
  assert.deepEqual(await new PgLadderStore(pool).seriesWithRunway('@p091b_none'), []);
});

test('okSources: only feeds and pages whose probe is ok and at most 6 h old', { skip }, async () => {
  const probes = new PgSourceProbes(pool);
  const probe = (u: string, ok: boolean, ageH: number) => ({
    ok, failure_class: ok ? null : 'timeout', status: ok ? 200 : null, kind: 'rss', feed_url: u, items: ok ? 5 : 0, newest_at: null, sample_titles: [],
    checked_at: new Date(NOW.getTime() - ageH * 3_600_000).toISOString(), via_proxy: false, url: u, detail: '', ms: 10, cached: false, blocked_until: null,
  }) as any;
  await probes.put(probe('https://good.example/rss', true, 1));
  await probes.put(probe('https://stale.example/rss', true, 9));
  await probes.put(probe('https://bad.example/rss', false, 1));
  const c = card({ sources: [
    { id: 'good', kind: 'rss', ref: 'https://good.example/rss' }, { id: 'stale', kind: 'rss', ref: 'https://stale.example/rss' },
    { id: 'bad', kind: 'rss', ref: 'https://bad.example/rss' }, { id: 'never', kind: 'rss', ref: 'https://never.example/rss' },
    { id: 'lib', kind: 'library', ref: FULL },
  ] });
  assert.deepEqual((await new PgLadderStore(pool).okSources(c, NOW)).map((s) => s.id), ['good']);
});

test('evergreenToday counts written evergreen posts, ladder runs and controller evergreen slots of the local day', { skip }, async () => {
  const store = new PgLadderStore(pool);
  assert.equal(await store.evergreenToday(card(), NOW), 0);
  await slot({ status: 'published', at: '2026-11-07T08:00:00Z', spec: { story: { kind: 'evergreen' } } });
  await slot({ status: 'skipped', at: '2026-11-07T08:30:00Z', fallback: { steps: [{ step: 'evergreen', outcome: 'rejected' }] } });
  await slot({ status: 'planned', at: '2026-11-07T15:00:00Z', slo: { replaces: null, rung: 'evergreen', cause: null, depth: 1 } });
  await slot({ status: 'skipped', at: '2026-11-07T09:30:00Z', slo: { replaces: null, rung: 'evergreen', cause: null, depth: 1 } });   // the controller's slot never ran: not counted
  await slot({ status: 'published', at: '2026-11-06T08:00:00Z', spec: { story: { kind: 'evergreen' } } });                          // yesterday
  await slot({ status: 'published', at: '2026-11-07T10:00:00Z', spec: { story: { kind: 'news' } } });
  assert.equal(await store.evergreenToday(card(), NOW), 3);
});

test('isDark reads today channel_slo; the ladder lifts the evergreen cap while dark', { skip }, async () => {
  const store = new PgLadderStore(pool);
  assert.equal(await store.isDark(card(), NOW), false);
  const ladder = new RecoveryLadder({ store, env: () => undefined });
  assert.deepEqual(await ladder.evergreenRoom(card(), NOW), { used: 3, cap: 1, dark: false });
  await pool.query(`INSERT INTO channel_slo (channel_key, day, target, state) VALUES ($1, '2026-11-07', 2, 'dark')`, [CH]);
  assert.equal(await store.isDark(card(), NOW), true);
  assert.deepEqual(await ladder.evergreenRoom(card(), NOW), { used: 3, cap: 2, dark: true });
});

test('RecoveryLadder end to end over PG: a no_material skip of a fixed slot goes to the series with runway', { skip }, async () => {
  const closed: ClosedSlot = {
    id: 's1', channelKey: CH, scheduledAt: NOW, status: 'skipped', error: null, format: 'text', topic: 'Тема', seriesName: 'Порожня серія',
    topicMode: 'fixed', live: null, sourceHints: [], slo: null,
  };
  const r = await new RecoveryLadder({ store: new PgLadderStore(pool), env: () => undefined }).choose(card(), closed, 'no_material', [], NOW);
  assert.equal(r!.rung, 'other_series');
  assert.equal(r!.spec.seriesName, 'Повна серія');
});

test('recentPublished: formats and source hosts of the last 14 days, most used first; older and unpublished slots left out', { skip }, async () => {
  const pub = (at: string, format: string, u: string) => slot({ status: 'published', at, format, spec: { source: { url: u } } });
  await pub('2026-11-05T08:00:00Z', 'photo', 'https://www.nasa.gov/a');
  await pub('2026-11-04T08:00:00Z', 'photo', 'https://nasa.gov/b');
  await pub('2026-11-03T08:00:00Z', 'poll', 'https://esa.int/c');
  await pub('2026-10-01T08:00:00Z', 'album', 'https://old.example/x');
  await slot({ status: 'skipped', at: '2026-11-05T09:00:00Z', format: 'video', spec: { source: { url: 'https://skipped.example/x' } } });
  const r = await recentPublished(pool, CH, NOW);
  assert.deepEqual(r.formats.slice(0, 2).sort(), ['photo', 'text'], 'photo x2, text x? — the two most used');
  assert.ok(r.formats.includes('poll'));
  assert.ok(!r.formats.includes('album') && !r.formats.includes('video'));
  assert.ok(r.hosts.includes('nasa.gov') && r.hosts.includes('esa.int'));
  assert.equal(r.hosts[0], 'nasa.gov', 'two nasa.gov posts (www. stripped)');
  assert.ok(!r.hosts.includes('old.example') && !r.hosts.includes('skipped.example'));
});
