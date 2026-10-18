/**
 * Spec 049 FR-001 / FR-002: Meta token expiry reaches the health check; a broken resource reminds once a day
 * (with "since"), can be muted, announces its fix; its claimed slots are skipped with the reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResourceHealthService, UNAVAILABLE_ERROR, dismissHealth } from './resource-health.service';
import { ResourceCatalog } from '../agents/resource-catalog';
import { EditorScheduler } from '../editor.scheduler';
import { makeCard } from '../post/testing/fixtures';

const DAY = 86_400_000;
const T0 = new Date('2026-10-18T06:10:00Z');

function harness(access: () => { state: any; detail: string; expiresAt?: string }) {
  const store = new Map<string, any>();
  const posts: any[] = [];
  const once: any[] = [];
  let now = T0;
  const h = new ResourceHealthService({
    catalog: { list: async () => [{ ref: 'threads:a1' }] as any, access: async () => access() },
    profiles: {
      setHealth: async (ref, hh) => { const prev = store.get(ref)?.state ?? null; store.set(ref, hh); return prev; },
      get: async (ref) => (store.has(ref) ? { health: store.get(ref) } as any : null),
    },
    inbox: {
      post: async (i) => { posts.push(i); return 1; },
      postOnce: async (i) => { if (once.some((x) => x.kind === i.kind && x.refId === i.refId)) return null; once.push(i); return 1; },
    },
    now: () => now,
  });
  return { h, store, posts, once, at: (d: Date) => { now = d; } };
}

test('a broken resource: one change note, then one reminder a day with "since"; the fix is announced', async () => {
  let state: any = 'token_invalid';
  const w = harness(() => ({ state, detail: 'token expired on 2026-08-17' }));
  await w.h.run();
  assert.equal(w.posts.length, 1);
  assert.equal(w.posts[0].kind, 'resource_health');
  assert.equal(w.store.get('threads:a1').since, T0.toISOString());

  await w.h.run(); // same day: the change note already said it
  assert.equal(w.once.length, 0);

  w.at(new Date(T0.getTime() + 3 * DAY));
  await w.h.run();
  await w.h.run(); // a re-check the same day (a due slot): deduped per Kyiv day
  assert.equal(w.once.length, 1);
  assert.match(w.once[0].title, /token_invalid \(since 2026-10-18, 3 d\)/);
  assert.equal(w.once[0].refType, 'resource_day');
  assert.equal(w.once[0].refId, 'threads:a1|2026-10-21');
  assert.equal(w.store.get('threads:a1').since, T0.toISOString(), 'since is kept while the state stays');

  state = 'ok';
  await w.h.run();
  assert.equal(w.posts.at(-1).kind, 'resource_health_ok');
  assert.match(w.posts.at(-1).body, /Was token_invalid since 2026-10-18/);
  assert.equal(w.store.get('threads:a1').since, undefined);
});

test('muted reminders stay muted until the state changes', async () => {
  let state: any = 'no_access';
  const w = harness(() => ({ state, detail: 'the bot is not an administrator' }));
  await w.h.run();
  assert.equal(await dismissHealth({ get: async (r) => ({ health: w.store.get(r) }) as any, setHealth: async (r, hh) => { w.store.set(r, hh); return null; } }, 'threads:a1', T0), true);
  w.at(new Date(T0.getTime() + DAY));
  await w.h.run();
  assert.equal(w.once.length, 0);
  assert.ok(w.store.get('threads:a1').dismissedAt);

  state = 'token_invalid'; // a new problem: a new note, the mute is gone
  await w.h.run();
  assert.equal(w.posts.at(-1).kind, 'resource_health');
  assert.equal(w.store.get('threads:a1').dismissedAt, undefined);
  assert.equal(await w.h.dismiss('nope:1'), false);
});

test('an expiring token: the change note at 7 days, daily reminders only in the last 2', async () => {
  const exp = new Date(T0.getTime() + 6 * DAY).toISOString();
  const w = harness(() => ({ state: 'token_expiring', detail: 'token expires soon', expiresAt: exp }));
  await w.h.run();
  assert.equal(w.posts.length, 1);
  assert.equal(w.posts[0].severity, 'action');
  w.at(new Date(T0.getTime() + 2 * DAY));
  await w.h.run();
  assert.equal(w.once.length, 0, '4 days left: no reminder yet');
  w.at(new Date(T0.getTime() + 4.5 * DAY));
  await w.h.run();
  assert.equal(w.once.length, 1);
  assert.equal(await w.h.usable('threads:a1'), true, 'an expiring token still publishes');
});

test('blocked(): a fresh blocking state is the skip reason; a stale one is checked again first', async () => {
  let state: any = 'token_invalid';
  const w = harness(() => ({ state, detail: 'expired' }));
  assert.equal(await w.h.blocked('threads:a1'), null, 'never checked');
  await w.h.run();
  assert.equal(await w.h.blocked('threads:a1'), `${UNAVAILABLE_ERROR}: token_invalid — expired`);
  state = 'ok';
  assert.ok(await w.h.blocked('threads:a1'), 'checked 0 min ago: the stored state stands');
  w.at(new Date(T0.getTime() + 31 * 60_000));
  assert.equal(await w.h.blocked('threads:a1'), null, 'the owner reconnected: re-checked, not blocked');
});

test('Meta access: an expired or invalid token is token_invalid, one expiring within 7 days is token_expiring', async () => {
  const row = (r: Record<string, unknown>) => ({ active: true, last_verified_at: new Date(T0.getTime() - 3600_000), verify_error: null, token_expires_at: null, token_valid: null, ...r });
  const catalog = (r: Record<string, unknown>) => new ResourceCatalog({ pool: { query: async () => ({ rows: [row(r)] }) } as any, now: () => T0 } as any);
  assert.equal((await catalog({}).access('instagram:1')).state, 'ok');
  const expired = await catalog({ token_expires_at: new Date(T0.getTime() - DAY) }).access('threads:1');
  assert.deepEqual([expired.state, expired.detail], ['token_invalid', 'token expired on 2026-10-17']);
  assert.equal((await catalog({ token_valid: false }).access('facebook:1')).state, 'token_invalid');
  const soon = await catalog({ token_expires_at: new Date(T0.getTime() + 3 * DAY) }).access('instagram:1');
  assert.equal(soon.state, 'token_expiring');
  assert.match(soon.detail, /3 d left/);
  assert.ok(soon.expiresAt);
  assert.equal((await catalog({ token_expires_at: new Date(T0.getTime() + 30 * DAY) }).access('instagram:1')).state, 'ok');
});

test('scheduler: a claimed slot on a resource that cannot publish is skipped with the reason, not run', async () => {
  const calls: string[] = [];
  const s = new EditorScheduler({
    pool: { query: async () => ({ rows: [] }) } as any,
    channels: { listActive: async () => [{ ...makeCard({ channelKey: '@space', planHour: 0 }), createdAt: new Date('2026-01-01') }] },
    plans: {
      getActivePlan: async () => null, skipStale: async () => 0, sweepStuck: async () => [], consecutiveFailures: async () => 0,
      claimDue: async () => [{ id: 'tg', channelKey: '@space', resourceRef: null }, { id: 'th', channelKey: '@space', resourceRef: 'threads:a1' }] as any,
      updateSlot: async (id: string, p: any) => { calls.push(`update:${id}:${p.status}:${p.error}`); },
    },
    runner: { runPlanner: async () => ({}) as any, runExecutor: async (slot: any) => { calls.push(`exec:${slot.id}`); return {} as any; }, runReviewer: async () => ({}) as any },
    orchestrate: async () => {}, enabled: () => true, notify: async () => {},
    unavailable: async (ref) => (ref === 'threads:a1' ? `${UNAVAILABLE_ERROR}: token_invalid — expired` : null),
  } as any);
  await s.tick(T0);
  assert.deepEqual(calls.filter((c) => c.startsWith('update:') || c.startsWith('exec:')),
    ['update:th:skipped:resource_unavailable: token_invalid — expired', 'exec:tg']);
});
