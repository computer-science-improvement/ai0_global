/**
 * Spec 061 FR-001 / FR-003 against a throwaway Postgres (init.sql + every migration, own database, dropped at the end):
 * the pre-flight over the real content ledger, host-failure table and idea pool (skip, swap, claim), `retopicSlot`, and
 * `settleIdea` by slot outcome (used only when a post is out; infra / budget / hosting back to accepted; no material rejected).
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { createProbeDb, type ProbeDb } from '../agents/testing/probe-db';
import { AgentsRepository } from '../agents/agents.repository';
import { NetworkRepository } from '../network/network.repository';
import { EditorPlansRepository } from '../repo/editor-plans.repository';
import { ContentLedger } from '../../data/content-ledger';
import { PgHostFailures } from '../net/host-failures';
import { buildSlotPreflight } from './preflight-wiring';
import { makeCard } from '../post/testing/fixtures';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pg061pre';
const REF = `telegram:${CH}`;
let db: ProbeDb;
let pool: Pool;
let net: NetworkRepository;
let plans: EditorPlansRepository;
let orchId: string;
let planId: string;

const addIdea = (title: string, sources: string[], over: { hoursOld?: number; format?: string } = {}) => net.addIdea({
  agentId: orchId, title, sources, status: 'accepted', origin: 'orchestrator', expiresAt: new Date(Date.now() + 86_400_000),
  variants: [{ resource_ref: REF, format: over.format ?? 'photo' }],
}).then(async (i) => {
  if (over.hoursOld) await pool.query(`UPDATE content_ideas SET created_at = now() - make_interval(hours => $2) WHERE id = $1`, [i.id, over.hoursOld]);
  return (await net.idea(i.id))!;
});

async function addSlot(ideaId: string | null, status = 'running', over: { error?: string | null; hints?: string[] } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, source_hints, status, idea_id, error)
     VALUES ($1, $2, now(), 'photo', 'старе', $3, $4, $5, $6) RETURNING id`,
    [planId, CH, JSON.stringify(over.hints ?? []), status, ideaId, over.error ?? null]);
  return rows[0].id as string;
}

before(async () => {
  if (!url) return;
  db = await createProbeDb(url, 'p061_preflight');
  pool = db.pool;
  net = new NetworkRepository(pool);
  plans = new EditorPlansRepository(pool);
  orchId = (await new AgentsRepository(pool).insert({ kind: 'orchestrator', scope: 'resource', scopeId: REF, name: 'P061', handle: 'p061_orch', mode: 'live', createdBy: 'owner' })).id;
  await pool.query(`INSERT INTO editor_channels (channel_key, mode, formats) VALUES ($1, 'live', '{"photo":1}')`, [CH]);
  planId = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ($1, current_date) RETURNING id`, [CH])).rows[0].id;
});
after(async () => {
  if (!url) return;
  await db.drop();
});

test('settleIdea: a slot that went out makes the idea used; a pending slot keeps it planned', { skip }, async () => {
  const out = await addIdea('out', ['https://p061.example/out']);
  await pool.query(`UPDATE content_ideas SET status = 'planned' WHERE id = $1`, [out.id]);
  await addSlot(out.id, 'published');
  await addSlot(out.id, 'skipped', { error: 'preflight_stale: x' });
  await net.settleIdea(out.id);
  assert.equal((await net.idea(out.id))!.status, 'used');

  const pending = await addIdea('pending', ['https://p061.example/pending']);
  await pool.query(`UPDATE content_ideas SET status = 'planned' WHERE id = $1`, [pending.id]);
  await addSlot(pending.id, 'planned');
  await addSlot(pending.id, 'skipped', { error: 'budget: x' });
  await net.settleIdea(pending.id);
  assert.equal((await net.idea(pending.id))!.status, 'planned');
});

test('settleIdea by skip outcome: back to accepted / rejected with the reason / used (critic, content)', { skip }, async () => {
  const cases: Array<[string, string, 'accepted' | 'rejected' | 'used']> = [
    ['skipped', 'preflight_format_unavailable: carousel', 'accepted'],
    ['skipped', 'budget: global budget', 'accepted'],
    ['skipped', 'series_paused: 3 skips', 'accepted'],
    ['failed', 'max_steps: ran out', 'accepted'],
    ['skipped', 'preflight_stale: stale', 'rejected'],
    ['skipped', 'preflight_source_used: spent', 'rejected'],
    ['skipped', 'preflight_host_blocked: host', 'rejected'],
    ['skipped', 'no_fresh_item: nothing', 'rejected'],
    ['skipped', 'critic_rejected: bad', 'used'],
    ['failed', 'lint_failed: x', 'used'],
  ];
  for (const [status, error, want] of cases) {
    const i = await addIdea(`case ${error}`, [`https://p061.example/${encodeURIComponent(error)}`]);
    await pool.query(`UPDATE content_ideas SET status = 'planned' WHERE id = $1`, [i.id]);
    await addSlot(i.id, status, { error });
    await net.settleIdea(i.id);
    const after = (await net.idea(i.id))!;
    assert.equal(after.status, want, error);
    if (want !== 'used') assert.equal(after.review?.slot_outcome, error.slice(0, 300), `${error}: the reason is kept in review`);
  }
});

test('pre-flight over the real ledger, host table and pool: spent source swaps to a fresh idea; the retopic is stored; the old idea is closed', { skip }, async () => {
  const spent = 'https://p061.example/spent';
  const fresh = 'https://p061.example/fresh';
  const a = await addIdea('spent idea', [spent]);
  await pool.query(`UPDATE content_ideas SET status = 'planned' WHERE id = $1`, [a.id]);
  const b = await addIdea('fresh idea', [fresh]);
  await new ContentLedger(pool).record(spent, { resourceRef: REF, origin: 'editor', status: 'published' });
  const slotId = await addSlot(a.id, 'running', { hints: [spent] });
  const slot = (await plans.getSlot(slotId))!;

  const pf = buildSlotPreflight({ pool, env: () => undefined, ideas: net, plans });
  const r = await pf.run(slot, makeCard({ channelKey: CH }));
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.swapped, 'swapped');
  const stored = (await plans.getSlot(slotId))!;
  assert.equal(stored.ideaId, b.id);
  assert.equal(stored.topic, 'fresh idea');
  assert.deepEqual(stored.sourceHints, [fresh]);
  assert.match(String(stored.lintWarnings?.[0]), /^preflight_swap:/);
  assert.equal((await net.idea(b.id))!.status, 'planned', 'the new idea is taken');
  const old = (await net.idea(a.id))!;
  assert.equal(old.status, 'rejected');
  assert.match(old.review.slot_outcome, /preflight:.*використано/);
});

test('pre-flight skip: a host blocked in source_host_failures, nothing to swap to', { skip }, async () => {
  await new PgHostFailures(pool).record('blocked061.example', 'refused', 403);
  const i = await addIdea('blocked idea', ['https://blocked061.example/story']);
  await pool.query(`UPDATE content_ideas SET status = 'planned' WHERE id = $1`, [i.id]);
  // The pool has no other accepted idea left that fits.
  await pool.query(`UPDATE content_ideas SET status = 'expired' WHERE agent_id = $1 AND status = 'accepted'`, [orchId]);
  const slotId = await addSlot(i.id, 'running', { hints: ['https://blocked061.example/story'] });
  const r = await buildSlotPreflight({ pool, env: () => undefined, ideas: net, plans }).run((await plans.getSlot(slotId))!, makeCard({ channelKey: CH }));
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, 'preflight_host_blocked');
});

test('claimIdea takes an accepted idea once; releaseIdea only touches a planned one', { skip }, async () => {
  const i = await addIdea('claim', ['https://p061.example/claim']);
  assert.equal(await net.claimIdea(i.id), true);
  assert.equal(await net.claimIdea(i.id), false, 'already planned');
  await net.releaseIdea(i.id, 'accepted', 'back');
  assert.equal((await net.idea(i.id))!.status, 'accepted');
  await net.releaseIdea(i.id, 'rejected', 'not planned: untouched');
  assert.equal((await net.idea(i.id))!.status, 'accepted');
});
