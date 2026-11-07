/**
 * Spec 090 FR-011 against a throwaway Postgres: the report sections read real rows (decisions, the human-only probes, the
 * directive timeout counts), the sweep words a closed card from the real log, and the decisions API lists and undoes.
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProbeDb, type ProbeDb } from '../agents/testing/probe-db';
import { AutonomyDecisionsRepository, AutonomyUndo } from '../autonomy/autonomy-decisions.repository';
import { AutonomyDecisionsController } from '../autonomy/autonomy-decisions.controller';
import { humanOnlyItems } from './autonomy-report';
import { OwnerReports, weekWork } from './owner-reports';
import { OwnerBotService, AUTO_APPLIED_UK } from './owner-bot.service';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
let db: ProbeDb;
let repo: AutonomyDecisionsRepository;

before(async () => {
  if (!url) return;
  db = await createProbeDb(url, 'p090c_report');
  repo = new AutonomyDecisionsRepository(db.pool);
});
after(async () => { if (db) await db.drop(); });

const NOW = new Date('2026-10-19T18:00:00Z');

function reports() {
  return new OwnerReports({
    pool: db.pool, repo: { async claimReport() { return true; }, async releaseReport() {}, async lastReports() { return { daily: null, weekly: null }; } } as any,
    budgets: async () => ({ rows: [] }), health: async () => { throw new Error('skip'); }, waiting: async () => [], env: () => undefined, now: () => NOW, decisions: repo,
  });
}

test('the daily report: empty log, no section; after decisions, counts and a failed line first', { skip }, async () => {
  assert.doesNotMatch((await reports().daily()).text, /Зроблено без вас/);
  await repo.record({ gate: 'directive:frequency', refType: 'directive', refId: 'd1', channelKey: '@a', action: 'applied', summary: 'Posting 3 times a day', at: new Date('2026-10-19T10:00:00Z') });
  await repo.record({ gate: 'pending_action:change_source', refType: 'pending_action', refId: 'a1', channelKey: '@a', action: 'failed', summary: 'Source change failed', at: new Date('2026-10-19T11:00:00Z') });
  const text = (await reports().daily()).text;
  assert.match(text, /<b>Зроблено без вас<\/b>\nдирективи: 1\nкартки агентів: 0 · ❌ помилок: 1\n❌ <b>@a<\/b>: Source change failed\n✅ <b>@a<\/b>: Posting 3 times a day/);
});

test('the weekly report: runs on the real schema, with the timeout counts and the human-only probes', { skip }, async () => {
  await db.pool.query(`INSERT INTO agent_inbox (kind, severity, title, parts, created_at) VALUES ('connection_broken', 'critical', 'x', NULL, $1)`, [new Date('2026-10-16T18:00:00Z')]);
  await db.pool.query(`INSERT INTO agent_inbox (kind, severity, title, parts) VALUES ('resource_health', 'action', 'y', ARRAY['state:token_expiring'])`);
  await db.pool.query(`INSERT INTO agent_inbox (kind, severity, title, parts) VALUES ('resource_health', 'action', 'z', ARRAY['state:token_invalid'])`);
  const items = await humanOnlyItems(db.pool);
  const conn = items.find((i) => i.label === 'Підключення й токени')!;
  assert.equal(conn.n, 2, 'connection_broken and token_invalid; token_expiring is not a gate');
  const text = (await reports().weekly()).text;
  assert.match(text, /<b>Чекає саме на вас<\/b>\n• Підключення й токени: 2 \(найстаріше — \d+ (дні|днів|день)\)/);
  assert.match(text, /Застосовано через вашу тишу: 0\nЗнято за браком відповіді: 0/);
  assert.match(text, /<b>Зроблено без вас<\/b>\nдирективи: 1/);
  const w = await weekWork(db.pool, new Date(NOW.getTime() - 7 * 86_400_000), NOW);
  assert.equal(w.timeoutApplied, 0);
});

test('every human-only probe is valid SQL on the real schema (a missing table would be skipped silently, so check each runs)', { skip }, async () => {
  // humanOnlyItems swallows errors per probe; here each table named by a probe must exist.
  for (const t of ['agent_inbox', 'editor_slots', 'channel_launches', 'agent_directives', 'steering_sets', 'network_offers']) {
    const { rows } = await db.pool.query(`SELECT to_regclass($1) AS r`, [t]);
    assert.ok(rows[0].r, t);
  }
});

test('the sweep words a card from the real decision log', { skip }, async () => {
  await repo.record({ gate: 'playbook', refType: 'playbook', refId: 'pb-1', channelKey: '@a', action: 'applied', summary: 'Playbook v2 activated' });
  const bot = new OwnerBotService({ pool: db.pool, repo: {} as any, api: null, sources: [], env: () => undefined, decisions: repo });
  assert.equal(await bot.silentOutcome({ kind: 'playbook', refId: 'pb-1' }), AUTO_APPLIED_UK);
  assert.equal(await bot.silentOutcome({ kind: 'playbook', refId: 'pb-2' }), null);
});

test('the API lists newest first with canUndo, and undoes through the registered handler', { skip }, async () => {
  const undo = new AutonomyUndo(repo);
  const ran: string[] = [];
  undo.register('t', async (u) => { ran.push(String(u.kind)); });
  const c = new AutonomyDecisionsController({ repo, undo });
  const id = (await repo.record({ gate: 'series_pause:no_material', refType: 'series_pause', refId: 'sp1', channelKey: '@z', action: 'resumed', summary: 'Series resumed', undo: { kind: 't' } }))!;
  const list = await c.list('@z', undefined, '10');
  assert.deepEqual(list.decisions.map((d) => [d.id, d.family, d.canUndo]), [[id, 'series_pause', true]]);
  const r = await c.undo(id);
  assert.equal(r.decision.canUndo, false);
  assert.equal(r.decision.undoneBy, 'owner');
  assert.deepEqual(ran, ['t']);
  const after = await c.list('@z');
  assert.deepEqual(after.decisions.map((d) => d.action), ['undone', 'resumed']);
});
