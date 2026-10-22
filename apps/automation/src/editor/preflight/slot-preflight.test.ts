// Spec 061 FR-001 / FR-003: the slot pre-flight (ledger, freshness, host block, format; one swap), the skip codes in the
// skip classifiers, and the idea outcome by slot outcome. Fakes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAvailable, preflightSkipError, SlotPreflight, type PreflightDeps } from './slot-preflight';
import { ideaOutcomeOf } from '../network/idea-outcome';
import { preflightCauseOf, skipGroupOf } from '../silent/skip-reasons';
import { EditorRunnerService } from '../roles/editor-runner.service';
import { SkillLibrary } from '../skills/skill-library';
import { makeCard } from '../post/testing/fixtures';

const NOW = new Date('2026-10-22T09:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const idea = (id: string, over: any = {}): any => ({
  id, agentId: 'orch1', title: `Ідея ${id}`, angle: 'кут', sources: [`https://news.example/${id}`],
  variants: [{ resource_ref: 'telegram:@chan', format: 'photo' }], status: 'accepted', createdAt: hoursAgo(2), expiresAt: new Date(NOW.getTime() + 86_400_000), ...over,
});
const slot = (over: any = {}): any => ({
  id: 's1', channelKey: '@chan', scheduledAt: NOW, kind: 'content', format: 'photo', topic: 'Тема', angle: null, sourceHints: ['https://news.example/a'],
  ideaId: 'a', isExperiment: false, status: 'running', attempts: 0, ...over,
});

function build(o: { ideas?: any[]; used?: Set<string>; blocked?: Set<string>; env?: Record<string, string>; hours?: number | null; claimed?: string[] } = {}) {
  const pool = new Map((o.ideas ?? []).map((i) => [i.id, i]));
  const retopics: any[] = [];
  const released: any[] = [];
  const claimed = o.claimed ?? [];
  const d: PreflightDeps = {
    ledger: { check: async (_r: string, url: string) => (o.used?.has(url) ? { used: true, status: 'published', resourceRef: 'telegram:@chan', ref: url, at: hoursAgo(30), slotId: 'old-slot' } : { used: false }) } as any,
    hosts: { blocked: async (host: string) => (o.blocked?.has(host) ? { host, reason: 'refused', statusCode: 403, until: new Date(NOW.getTime() + 86_400_000) } : null) } as any,
    ideas: {
      idea: async (id) => pool.get(id) ?? null,
      accepted: async (_a, limit) => [...pool.values()].filter((i) => i.status === 'accepted').slice(0, limit),
      claim: async (id) => { claimed.push(id); const i = pool.get(id); if (i?.status === 'accepted') { i.status = 'planned'; return true; } return false; },
      release: async (id, to, reason) => { released.push([id, to, reason]); },
    },
    retopic: async (id, p) => { retopics.push([id, p]); },
    env: (k) => o.env?.[k],
    freshnessHours: async () => (o.hours === undefined ? 36 : o.hours),
    now: () => NOW,
  };
  return { pf: new SlotPreflight(d), retopics, released, claimed };
}

test('a fresh, unspent, reachable source passes; nothing is swapped', async () => {
  const { pf } = build({ ideas: [idea('a')] });
  const r = await pf.run(slot(), makeCard());
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.swapped, undefined);
});

test('ledger: every source of the slot spent → preflight_source_used with the day and the slot; one unspent source is enough', async () => {
  const none = build({ ideas: [idea('a', { sources: ['https://news.example/a'] })], used: new Set(['https://news.example/a']) });
  const r = await none.pf.run(slot(), makeCard());
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, 'preflight_source_used');
  assert.match(!r.ok ? r.reason : '', /уже використано 2026-10-21 у слоті old-slot/);

  const some = build({ ideas: [idea('a', { sources: ['https://news.example/a', 'https://other.example/b'] })], used: new Set(['https://news.example/a']) });
  assert.equal((await some.pf.run(slot({ sourceHints: ['https://news.example/a', 'https://other.example/b'] }), makeCard())).ok, true);
});

test('freshness: an idea older than the channel limit is stale (36 h); a dated URL counts from its own day; no limit, no check', async () => {
  const stale = build({ ideas: [idea('a', { createdAt: hoursAgo(49) })] });
  const r = await stale.pf.run(slot(), makeCard());
  assert.equal(!r.ok && r.code, 'preflight_stale');
  assert.match(!r.ok ? r.reason : '', /49 год при межі 36 год/);

  const dated = build({ ideas: [idea('a', { sources: ['https://news.example/2026/10/18/old-story'], createdAt: hoursAgo(1) })] });
  const rd = await dated.pf.run(slot({ sourceHints: ['https://news.example/2026/10/18/old-story'] }), makeCard());
  assert.equal(!rd.ok && rd.code, 'preflight_stale', 'the article is from 18 Oct, whatever the idea age');

  const exempt = build({ ideas: [idea('a', { createdAt: hoursAgo(115) })], hours: null });
  assert.equal((await exempt.pf.run(slot(), makeCard())).ok, true, 'evergreen / explainer channels have no limit');
});

test('host block: every source host blocked → preflight_host_blocked', async () => {
  const { pf } = build({ ideas: [idea('a', { sources: ['https://www.marktechpost.com/x'] })], blocked: new Set(['marktechpost.com']) });
  const r = await pf.run(slot({ sourceHints: ['https://www.marktechpost.com/x'] }), makeCard());
  assert.equal(!r.ok && r.code, 'preflight_host_blocked');
  assert.match(!r.ok ? r.reason : '', /marktechpost\.com заблокований до/);
});

test('format: a carousel without slide hosting is preflight_format_unavailable; no swap is tried; with hosting it passes', async () => {
  const b = build({ ideas: [idea('a'), idea('b')] });
  const r = await b.pf.run(slot({ format: 'carousel' }), makeCard());
  assert.equal(!r.ok && r.code, 'preflight_format_unavailable');
  assert.match(!r.ok ? r.reason : '', /SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_CAROUSEL_BUCKET/);
  assert.equal(b.claimed.length, 0);
  const ok = build({ ideas: [idea('a')], env: { SUPABASE_URL: 'u', SUPABASE_SERVICE_KEY: 'k', SUPABASE_CAROUSEL_BUCKET: 'b' } });
  assert.equal((await ok.pf.run(slot({ format: 'carousel' }), makeCard())).ok, true);
  assert.deepEqual(formatAvailable('photo', () => undefined), { ok: true });
  assert.equal(formatAvailable('ig_carousel', () => undefined).ok, false, 'native carousels need hosting too');
});

test('swap: the next accepted idea that passes every check and fits the resource and format takes the slot', async () => {
  const ideas = [
    idea('a', { status: 'planned', createdAt: hoursAgo(60) }),                                   // the slot's own: stale
    idea('b', { sources: ['https://news.example/b'] }),                                          // spent
    idea('c', { variants: [{ resource_ref: 'telegram:@chan', format: 'poll' }] }),               // wrong format
    idea('d', { variants: [{ resource_ref: 'telegram:@other', format: 'photo' }] }),             // wrong resource
    idea('e', { expiresAt: hoursAgo(1) }),                                                       // expired
    idea('f', { sources: ['https://news.example/f'] }),                                          // the one
  ];
  const b = build({ ideas, used: new Set(['https://news.example/b']) });
  const r = await b.pf.run(slot(), makeCard());
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.swapped);
  assert.equal(r.ok && r.slot.ideaId, 'f');
  assert.equal(r.ok && r.slot.topic, 'Ідея f');
  assert.deepEqual(r.ok && r.slot.sourceHints, ['https://news.example/f']);
  assert.match((r.ok && r.slot.lintWarnings?.[0]) || '', /^preflight_swap:/);
  assert.equal(b.retopics[0][0], 's1');
  assert.equal(b.retopics[0][1].ideaId, 'f');
  assert.deepEqual(b.released[0].slice(0, 2), ['a', 'rejected'], 'the idea the slot gave up is closed with the reason');
  assert.match(b.released[0][2], /preflight:.*застаріло/);
});

test('no idea fits → the skip; a series slot and a derived slot are not swapped / checked', async () => {
  const b = build({ ideas: [idea('a', { status: 'planned', createdAt: hoursAgo(60) }), idea('b', { createdAt: hoursAgo(80) })] });
  const r = await b.pf.run(slot(), makeCard());
  assert.equal(!r.ok && r.code, 'preflight_stale');
  assert.equal(b.claimed.length, 0, 'the only other idea is stale too');

  const series = await build({ ideas: [idea('a', { createdAt: hoursAgo(60) }), idea('b')] }).pf.run(slot({ seriesName: 'Серія' }), makeCard());
  assert.equal(series.ok, false, 'a series slot is skipped, not swapped');
  const derived = await build({ ideas: [idea('a', { createdAt: hoursAgo(60) })] }).pf.run(slot({ treatment: 'duplicate' }), makeCard());
  assert.equal(derived.ok, true);
  const reserved = await build({}).pf.run(slot({ kind: 'reserved', ideaId: null }), makeCard());
  assert.equal(reserved.ok, true);
});

test('a live slot is not source-checked (its item is picked from the feeds); a failing check never stops the slot', async () => {
  const live = await build({ ideas: [idea('a', { createdAt: hoursAgo(60) })] }).pf.run(slot({ topicMode: 'live' }), makeCard());
  assert.equal(live.ok, true);
  const broken = new SlotPreflight({
    ledger: { check: async () => { throw new Error('db down'); } } as any, hosts: { blocked: async () => null } as any,
    ideas: { idea: async () => idea('a'), accepted: async () => [], claim: async () => false, release: async () => {} },
    retopic: async () => {}, env: () => undefined, freshnessHours: async () => 36, now: () => NOW,
  });
  assert.equal((await broken.run(slot(), makeCard())).ok, true);
});

test('skip codes: classified with the skip groups; the 060 cause class', () => {
  const e = preflightSkipError('preflight_stale', 'джерело застаріло');
  assert.equal(e, 'preflight_stale: джерело застаріло');
  for (const c of ['preflight_source_used', 'preflight_stale', 'preflight_host_blocked']) assert.equal(skipGroupOf(`${c}: x`), 'nothing_fresh', c);
  assert.equal(skipGroupOf('preflight_format_unavailable: x'), 'other');
  assert.equal(preflightCauseOf('preflight_source_used: x'), 'no_material');
  assert.equal(preflightCauseOf('preflight_stale: x'), 'no_material');
  assert.equal(preflightCauseOf('preflight_host_blocked: x'), 'source_unreachable');
  assert.equal(preflightCauseOf('preflight_format_unavailable: x'), 'infra');
  assert.equal(preflightCauseOf('critic_rejected: x'), null);
});

test('FR-003 idea outcome: used only when a post is out; infra / budget / format → accepted; no material / unreachable → rejected', () => {
  for (const s of ['published', 'shadowed', 'awaiting_approval', 'approved']) assert.equal(ideaOutcomeOf(s, null).status, 'used', s);
  assert.equal(ideaOutcomeOf('skipped', 'preflight_format_unavailable: x').status, 'accepted');
  assert.equal(ideaOutcomeOf('skipped', 'budget: global budget').status, 'accepted');
  assert.equal(ideaOutcomeOf('skipped', 'series_paused: 3 skips').status, 'accepted');
  assert.equal(ideaOutcomeOf('skipped', 'daily_cap_reached: 5/5').status, 'accepted');
  assert.equal(ideaOutcomeOf('failed', 'max_steps: no terminal').status, 'accepted');
  assert.equal(ideaOutcomeOf('skipped', 'preflight_stale: x').status, 'rejected');
  assert.equal(ideaOutcomeOf('skipped', 'preflight_source_used: x').status, 'rejected');
  assert.equal(ideaOutcomeOf('skipped', 'preflight_host_blocked: x').status, 'rejected');
  assert.equal(ideaOutcomeOf('skipped', 'no_fresh_item: nothing').status, 'rejected');
  assert.equal(ideaOutcomeOf('skipped', 'critic_rejected: x').status, 'used', 'critic: unchanged');
  assert.equal(ideaOutcomeOf('skipped', 'skipped by agent: weak', 'revise').status, 'used');
  assert.equal(ideaOutcomeOf('failed', 'lint_failed: x').status, 'used', 'a content failure: unchanged');
  const r = ideaOutcomeOf('skipped', 'preflight_stale: джерело застаріло');
  assert.equal(r.status === 'rejected' && r.reason, 'preflight_stale: джерело застаріло');
});

// ── the runner: the pre-flight runs before the executor, a skip costs no LLM call ──────────────────────────────

function runnerWith(preflight: any) {
  const updates: any[] = [];
  const runs: any[] = [];
  const done: any[] = [];
  const runner = new EditorRunnerService({
    loop: { run: async (i: any) => { runs.push(i); return { runId: 'r1', status: 'ok', terminalTool: 'publish_post' } as any; } },
    registry: { forRole: () => [] as any },
    skills: new SkillLibrary(),
    plans: { reservedSlots: async () => [], getSlot: async () => ({ ...slot(), status: 'published' }), updateSlot: async (id: string, p: any) => { updates.push([id, p]); } },
    memory: { listActive: async () => [] },
    env: () => undefined,
    notify: async () => {},
    now: () => NOW,
    onSlotDone: async (s: any) => { done.push(s.id); },
    preflight,
  } as any);
  return { runner, updates, runs, done };
}

test('runner: a failing pre-flight skips the slot with the code and the reason, no loop run, the idea is settled', async () => {
  const h = runnerWith({ run: async () => ({ ok: false, code: 'preflight_stale', reason: 'джерело застаріло', problem: {} }) });
  await h.runner.runExecutor(slot(), makeCard());
  assert.equal(h.runs.length, 0, 'no LLM call');
  assert.deepEqual(h.updates, [['s1', { status: 'skipped', error: 'preflight_stale: джерело застаріло' }]]);
  assert.deepEqual(h.done, ['s1']);
});

test('runner: a swapped slot runs with the new topic', async () => {
  const swapped = slot({ topic: 'Нова тема', ideaId: 'f' });
  const h = runnerWith({ run: async () => ({ ok: true, slot: swapped, swapped: {} }) });
  await h.runner.runExecutor(slot(), makeCard());
  assert.equal(h.runs.length, 1);
  assert.match(h.runs[0].user, /Нова тема/);
});
