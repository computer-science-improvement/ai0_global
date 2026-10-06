/**
 * Spec 024 T1: the auto-duplicate gate (truth table and plan-day pin), the
 * gate in EditorCrossPoster and GroupFanOutService, and the network-mode
 * endpoint with its deprecated aliases.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutoDuplicateState, autoDuplicateRaw, NetworkRepository } from './network.repository';
import { NetworkService } from './network.service';
import { EditorCrossPoster } from '../publish/editor-crosspost';
import { GroupFanOutService } from '../../common/content-strategy/group-fanout.service';
import { EditorScheduler } from '../editor.scheduler';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import type { ChannelMode } from '../card';

// ── truth table ────────────────────────────────────────────────────────────

const MODES: ChannelMode[] = ['off', 'shadow', 'approve', 'live'];
const st = (o: Partial<AutoDuplicateState> = {}): AutoDuplicateState => ({
  mode: 'independent', cardMode: 'live', orchestratorMode: 'live', orchestratorPaused: false, hasPlaybook: true, ...o,
});

test('autoDuplicateRaw: false only for independent + live (orchestrator ∧ card) + active playbook', () => {
  for (const mode of ['independent', 'legacy_duplicate']) {
    for (const orch of MODES) {
      for (const card of MODES) {
        for (const hasPlaybook of [true, false]) {
          const want = !(mode === 'independent' && orch === 'live' && card === 'live' && hasPlaybook);
          assert.equal(autoDuplicateRaw(st({ mode, orchestratorMode: orch, cardMode: card, hasPlaybook })), want, `${mode} ${orch}/${card} pb=${hasPlaybook}`);
        }
      }
    }
  }
  assert.equal(autoDuplicateRaw(st({ orchestratorPaused: true })), true, 'a paused orchestrator publishes nothing → keep duplicating');
  assert.equal(autoDuplicateRaw(st({ orchestratorMode: null })), true, 'no orchestrator on the anchor');
  assert.equal(autoDuplicateRaw(st({ cardMode: null })), true, 'no editor card on the anchor');
});

// ── plan-day pin (fake pool) ───────────────────────────────────────────────

/** A meta_account_groups row + the joined gate inputs, enough for NetworkRepository's gate queries. */
function gatePool(init: { mode: string; orch: ChannelMode; card: ChannelMode; playbook: boolean; tz?: string }) {
  const s = { ...init, day: null as string | null, pinned: null as boolean | null, updates: 0 };
  const pool = {
    query: async (sql: string, params: any[] = []) => {
      if (/FROM meta_account_groups g\s+LEFT JOIN LATERAL/.test(sql)) {
        return { rows: [{ mode: s.mode, pinned_day: s.day, pinned: s.pinned, card_mode: s.card, timezone: s.tz ?? 'Europe/Kyiv', orch_mode: s.orch, orch_status: 'active', paused_until: null, has_playbook: s.playbook }] };
      }
      if (/^\s*UPDATE meta_account_groups SET auto_duplicate_day/.test(sql)) {
        if (s.day === params[1] && s.pinned != null) return { rows: [] };
        s.day = params[1]; s.pinned = params[2]; s.updates++;
        return { rows: [{ auto_duplicate: s.pinned }] };
      }
      if (/^\s*UPDATE meta_account_groups SET mode/.test(sql)) { s.mode = params[1]; return { rows: [] }; }
      if (/SELECT auto_duplicate FROM/.test(sql)) return { rows: [{ auto_duplicate: s.pinned }] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return { s, repo: new NetworkRepository(pool as any) };
}

test('autoDuplicateActive: a change takes effect at the anchor plan-day boundary', async () => {
  const { s, repo } = gatePool({ mode: 'independent', orch: 'shadow', card: 'live', playbook: true });
  const morning = new Date('2026-10-06T06:00:00Z');   // 09:00 Kyiv
  assert.equal(await repo.autoDuplicateActive('g1', morning), true, 'shadow keeps auto-duplication');
  s.orch = 'live';                                      // the orchestrator goes live mid-day
  assert.equal(await repo.autoDuplicateActive('g1', new Date('2026-10-06T12:00:00Z')), true, 'today stays pinned');
  assert.equal(await repo.autoDuplicateActive('g1', new Date('2026-10-06T20:59:00Z')), true, '23:59 Kyiv is still today');
  assert.equal(await repo.autoDuplicateActive('g1', new Date('2026-10-06T21:01:00Z')), false, '00:01 Kyiv next day → gate closed');
  // …and back: switching to legacy_duplicate re-opens it only from the next plan day.
  await repo.setGroupMode('g1', 'legacy_duplicate', new Date('2026-10-07T09:00:00Z'));
  assert.equal(await repo.autoDuplicateActive('g1', new Date('2026-10-07T10:00:00Z')), false);
  assert.equal(await repo.autoDuplicateActive('g1', new Date('2026-10-07T21:30:00Z')), true);
  assert.equal(s.updates, 3, 'one pin per plan day');
});

test('autoDuplicateActive: the plan day follows the anchor card zone', async () => {
  const { repo } = gatePool({ mode: 'independent', orch: 'live', card: 'live', playbook: false, tz: 'America/New_York' });
  assert.equal(await repo.autoDuplicateActive('g1', new Date('2026-10-07T02:00:00Z')), true, '22:00 New York on Oct 6, no playbook');
  // The playbook is approved; at 23:30 New York (03:30 UTC, already Oct 7 in Kyiv) it is still Oct 6 for the anchor.
  const { s, repo: r2 } = gatePool({ mode: 'independent', orch: 'live', card: 'live', playbook: false, tz: 'America/New_York' });
  await r2.autoDuplicateActive('g1', new Date('2026-10-07T02:00:00Z'));
  s.playbook = true;
  assert.equal(await r2.autoDuplicateActive('g1', new Date('2026-10-07T03:30:00Z')), true);
  assert.equal(await r2.autoDuplicateActive('g1', new Date('2026-10-07T04:30:00Z')), false, '00:30 New York');
  assert.ok(repo);
});

test('autoDuplicateActive: unknown group → true; an invalid anchor zone falls back to Kyiv', async () => {
  const empty = new NetworkRepository({ query: async () => ({ rows: [] }) } as any);
  assert.equal(await empty.autoDuplicateActive('nope'), true);
  const { s, repo } = gatePool({ mode: 'independent', orch: 'live', card: 'live', playbook: true, tz: 'Mars/Olympus' });
  assert.equal(await repo.autoDuplicateActive('g1', new Date('2026-10-06T21:30:00Z')), false);
  assert.equal(s.day, '2026-10-07', 'Kyiv date');
});

// ── EditorCrossPoster ──────────────────────────────────────────────────────

const req = () => ({ channelKey: '@chan', messageId: 42, spec: makeSpec(), card: makeCard(), prepared: {} });

function poster(gate?: (k: string) => Promise<boolean>) {
  const calls = { cp: 0, gf: 0 };
  const p = new EditorCrossPoster({
    crossPost: { afterPublish: async () => { calls.cp++; return []; } },
    groupFanOut: { fanOut: async () => { calls.gf++; return []; } },
    postLink: () => null,
    ...(gate ? { autoDuplicateActive: gate } : {}),
  });
  return { p, calls };
}

test('EditorCrossPoster: a closed gate skips both the crosspost targets and the group', async () => {
  const closed = poster(async () => false);
  assert.deepEqual(await closed.p.fanOut(req()), []);
  assert.deepEqual(closed.calls, { cp: 0, gf: 0 });
  const open = poster(async () => true);
  await open.p.fanOut(req());
  assert.deepEqual(open.calls, { cp: 1, gf: 1 });
  const broken = poster(async () => { throw new Error('db down'); });
  await broken.p.fanOut(req());
  assert.deepEqual(broken.calls, { cp: 1, gf: 1 }, 'unknown gate → keep duplicating');
  const none = poster();
  await none.p.fanOut(req());
  assert.deepEqual(none.calls, { cp: 1, gf: 1 });
});

// ── GroupFanOutService (strategy path) ─────────────────────────────────────

function fanOut(gate?: { autoDuplicateActive(g: string): Promise<boolean> }) {
  const calls: string[] = [];
  const events: any[] = [];
  const resolver = {
    resolveGroupForDest: async () => ({ groupId: 'g1', sourcePlatform: 'facebook', isSource: true }),
    resolveGroupTargets: async () => [
      { platform: 'instagram', targetId: 't-ig', token: 'x', metaAccountId: 'ig', postedKey: 'IG:ig', throttleKey: 'meta:ig' },
      { platform: 'telegram', targetId: '@chan', metaAccountId: null, postedKey: 'TELEGRAM', throttleKey: '@chan' },
    ],
  };
  const dispatcher = { publish: async (p: string) => { calls.push(p); return 'id'; }, publishCarousel: async (p: string) => { calls.push(p); return 'id'; } };
  const telegram = { publish: async () => { calls.push('telegram'); return 'tg'; } };
  const tracer = { event: (...a: any[]) => events.push(a) };
  const svc = new GroupFanOutService(resolver as any, dispatcher as any, telegram as any, tracer as any, undefined, gate as any);
  return { svc, calls, events };
}
const SOURCE = { platform: 'facebook', targetId: 'fb', token: 't', metaAccountId: 'fb', postedKey: 'FB:fb', throttleKey: 'meta:fb' } as any;
const CONTENT = { caption: 'A caption long enough to post.', tags: [], imageUrls: ['u1'], carousel: false };

test('GroupFanOutService: skipped per target and traced only when the gate is false', async () => {
  const closed = fanOut({ autoDuplicateActive: async () => false });
  const out = await closed.svc.fanOut(SOURCE, CONTENT, async () => {});
  assert.deepEqual(out, [
    { platform: 'instagram', status: 'skipped', detail: 'independent network' },
    { platform: 'telegram', status: 'skipped', detail: 'independent network' },
  ]);
  assert.deepEqual(closed.calls, []);
  assert.deepEqual(closed.events.map((e) => [e[0], e[1], e[2]]), [['GroupFanOut', 'publish:instagram', 'skipped'], ['GroupFanOut', 'publish:telegram', 'skipped']]);

  const open = fanOut({ autoDuplicateActive: async () => true });
  assert.deepEqual((await open.svc.fanOut(SOURCE, CONTENT, async () => {})).map((o) => o.status), ['ok', 'ok']);
  assert.deepEqual(open.calls, ['instagram', 'telegram']);

  const broken = fanOut({ autoDuplicateActive: async () => { throw new Error('db down'); } });
  await broken.svc.fanOut(SOURCE, CONTENT, async () => {});
  assert.deepEqual(broken.calls, ['instagram', 'telegram'], 'unknown gate → mirror as before');

  const ungated = fanOut(undefined);
  await ungated.svc.fanOut(SOURCE, CONTENT, async () => {});
  assert.deepEqual(ungated.calls, ['instagram', 'telegram']);
});

// ── network-mode endpoint ──────────────────────────────────────────────────

function service(o: { group?: boolean; playbook?: boolean } = {}) {
  const posted: any[] = [];
  const modes: string[] = [];
  const logs: string[] = [];
  const orch = { id: 'o1', handle: 'kira', scope: 'resource', scopeId: 'telegram:@space', parentId: null, mode: 'shadow' };
  const repo = {
    groupOfChannel: async () => (o.group === false ? null : { id: 'g1', name: 'Space', mode: 'legacy_duplicate' }),
    setGroupMode: async (_g: string, m: string) => { modes.push(m); },
    activePlaybook: async () => (o.playbook ? { id: 'p', version: 1 } : null),
  };
  const svc = new NetworkService({
    pool: { query: async () => ({ rows: [] }) } as any,
    agents: { getByHandle: async () => orch, get: async () => null } as any,
    repo: repo as any,
    inbox: { post: async (x: any) => { posted.push(x); } } as any,
    card: async () => makeCard({ channelKey: '@space' }) as any,
    rebuild: async () => null,
    log: (m) => logs.push(m),
  });
  return { svc, posted, modes, logs };
}

test('network-mode: independent / legacy_duplicate; orchestrated / mirror are logged aliases; no playbook needed', async () => {
  const a = service();
  assert.deepEqual(await a.svc.setMode('kira', { mode: 'independent' }), { mode: 'independent', group: 'Space' });
  assert.match(a.posted[0].body, /only Telegram is planned/);
  assert.deepEqual(await a.svc.setMode('kira', { mode: 'legacy_duplicate' }), { mode: 'legacy_duplicate', group: 'Space' });
  assert.deepEqual(await a.svc.setMode('kira', { mode: 'orchestrated' }), { mode: 'independent', group: 'Space', deprecated_alias: 'orchestrated' });
  assert.deepEqual(await a.svc.setMode('kira', { mode: 'mirror' }), { mode: 'legacy_duplicate', group: 'Space', deprecated_alias: 'mirror' });
  assert.deepEqual(a.modes, ['independent', 'legacy_duplicate', 'independent', 'legacy_duplicate']);
  assert.equal(a.logs.filter((l) => /deprecated/.test(l)).length, 2);
  assert.ok(a.posted.every((p) => p.kind === 'network_mode' && !/[А-Яа-яЇїІіЄєҐґ]/.test(p.title + p.body)), 'owner-facing text is English');

  const withPb = service({ playbook: true });
  await withPb.svc.setMode('kira', { mode: 'independent' });
  assert.doesNotMatch(withPb.posted[0].body, /only Telegram is planned/);

  await assert.rejects(a.svc.setMode('kira', { mode: 'chaos' }), (e: any) => e.getResponse().error === 'invalid_body');
  await assert.rejects(service({ group: false }).svc.setMode('kira', { mode: 'independent' }), (e: any) => e.getResponse().error === 'no_network');
});

// ── scheduler pins the gate every tick ─────────────────────────────────────

test('scheduler: pinGate runs for every active card before planning, and its failure is only logged', async () => {
  const pinned: string[] = [];
  const logs: string[] = [];
  const cards = [makeCard({ channelKey: '@a', planHour: 23 }), makeCard({ channelKey: '@b', planHour: 23 })];
  const sch = new EditorScheduler({
    pool: { query: async () => ({ rows: [] }) } as any,
    channels: { listActive: async () => cards as any },
    plans: { getActivePlan: async () => null, claimDue: async () => [], skipStale: async () => 0, sweepStuck: async () => 0, consecutiveFailures: async () => 0 } as any,
    runner: { runPlanner: async () => null, runExecutor: async () => null, runReviewer: async () => null } as any,
    enabled: () => true, notify: async () => {}, log: (m) => logs.push(m),
    pinGate: async (card) => { pinned.push(card.channelKey); if (card.channelKey === '@b') throw new Error('db down'); },
  });
  await sch.tick(new Date('2026-10-06T06:00:00Z'));
  assert.deepEqual(pinned, ['@a', '@b']);
  assert.ok(logs.some((l) => /auto-duplicate gate of @b failed/.test(l)));
});
