/**
 * Spec 057: setup proposals expire — the TTL setting, the hourly throttled sweep, the one Inbox note per sweep, the minute tick
 * calling it, and `expired` as a closed status (apply and discard refuse it, the artifact row offers no action).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupAdapter } from '../artifacts/artifact-adapters';
import { settingDef } from '../../settings/catalog';
import { SETUP_SECTIONS } from './setup-analysis';
import { expiryNote, SetupExpiry, setupTtlDays, SETUP_EXPIRED_KIND } from './setup-expiry';
import { ChannelSetupService } from './setup.service';
import type { ChannelSetupRepository, SetupProposal } from './setup.repository';

const proposal = (id: string, channelKey: string, status: SetupProposal['status'] = 'expired'): SetupProposal => ({
  id, channelKey, resourceRef: `telegram:${channelKey}`, agentId: null, status, reason: null, retryAt: null, postIds: [], metrics: null,
  sections: { summary: 's' }, sectionStatus: { brief_profile: 'applied' }, baseline: null, runId: null, costUsd: 0, createdBy: 'owner',
  createdAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-09-01T00:00:00Z'), appliedAt: null,
});
const UUID = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;

function sweepRig(o: { expire?: (now: Date, ttl: number) => SetupProposal[]; ttl?: () => number; failPost?: boolean } = {}) {
  let now = new Date('2026-10-21T10:00:00Z');
  const calls: Array<{ now: Date; ttl: number; sections: readonly string[] }> = [];
  const notes: any[] = [];
  const logs: string[] = [];
  const sweep = new SetupExpiry({
    repo: { expireStale: async (n, ttl, sections) => { calls.push({ now: n, ttl, sections }); return o.expire?.(n, ttl) ?? []; } },
    inbox: { postOnce: async (i) => { if (o.failPost) throw new Error('db down'); notes.push(i); return notes.length; } },
    ttlDays: o.ttl ?? (() => 14), now: () => now, log: (m) => logs.push(m),
  });
  return { sweep, calls, notes, logs, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

test('ttl setting: an integer 0–365, empty or invalid is the default 14; the catalog entry matches', () => {
  assert.equal(setupTtlDays(undefined), 14);
  assert.equal(setupTtlDays(''), 14);
  assert.equal(setupTtlDays('30'), 30);
  assert.equal(setupTtlDays('0'), 0);
  assert.equal(setupTtlDays('365'), 365);
  assert.equal(setupTtlDays('366'), 14);
  assert.equal(setupTtlDays('-1'), 14);
  assert.equal(setupTtlDays('2.5'), 14);
  assert.equal(setupTtlDays('abc'), 14);
  const def = settingDef('SETUP_PROPOSAL_TTL_DAYS');
  assert.ok(def);
  assert.deepEqual([def.type, def.default, def.min, def.max, def.apply], ['int', '14', 0, 365, 'live']);
});

test('sweep: asks the repository for the TTL and the six sections; one note lists the channels', async () => {
  const r = sweepRig({ ttl: () => 7, expire: () => [proposal(UUID(2), '@b'), proposal(UUID(1), '@a')] });
  const out = await r.sweep.sweep();
  assert.equal(out.length, 2);
  assert.deepEqual(r.calls.map((c) => c.ttl), [7]);
  assert.deepEqual(r.calls[0].sections, SETUP_SECTIONS);
  assert.equal(r.notes.length, 1, 'one note per sweep, not one per proposal');
  const n = r.notes[0];
  assert.equal(n.kind, SETUP_EXPIRED_KIND);
  assert.equal(n.severity, 'info');
  assert.match(n.title, /@a, @b/);
  assert.match(n.body, /2 setup proposals were not applied for 7 days/);
  assert.match(n.alert.title, /Пропозиції налаштування закрито за терміном: @a, @b/);
  assert.match(n.alert.body, /2 пропозиції не застосовували 7 дн\./);
  assert.match(n.alert.body, /Розділи, які вже застосовано, лишаються/);
  assert.ok(n.refType && n.refId, 'postOnce needs a ref');
});

test('sweep: nothing expired = no note; TTL 0 never touches the repository', async () => {
  const none = sweepRig();
  assert.deepEqual(await none.sweep.sweep(), []);
  assert.equal(none.notes.length, 0);
  assert.equal(none.calls.length, 1);

  const off = sweepRig({ ttl: () => 0, expire: () => [proposal(UUID(1), '@a')] });
  assert.deepEqual(await off.sweep.sweep(), []);
  assert.equal(off.calls.length, 0, 'TTL 0 does nothing');
  assert.equal(off.notes.length, 0);
});

test('sweep: runs at most once an hour, and again after it', async () => {
  const r = sweepRig({ expire: () => [proposal(UUID(1), '@a')] });
  await r.sweep.sweep();
  r.advance(59 * 60_000);
  await r.sweep.sweep();
  assert.equal(r.calls.length, 1, 'throttled inside the hour');
  r.advance(61_000);
  await r.sweep.sweep();
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[1].now.toISOString(), '2026-10-21T11:00:01.000Z');
});

test('sweep: a failing Inbox post does not fail the sweep; the proposals are still reported', async () => {
  const r = sweepRig({ failPost: true, expire: () => [proposal(UUID(1), '@a')] });
  assert.equal((await r.sweep.sweep()).length, 1);
  assert.ok(r.logs.some((l) => /note failed: db down/.test(l)));
});

test('note: the same proposals give the same dedup ref, others a different one; long lists are cut', () => {
  const a = expiryNote([proposal(UUID(1), '@a'), proposal(UUID(2), '@b')], 14);
  const reversed = expiryNote([proposal(UUID(2), '@b'), proposal(UUID(1), '@a')], 14);
  const other = expiryNote([proposal(UUID(3), '@a')], 14);
  assert.equal(a.refId, reversed.refId);
  assert.notEqual(a.refId, other.refId);
  assert.match(other.title, /^Setup proposal expired: @a$/);
  assert.match(other.alert.body, /^1 пропозицію не застосовували 14 дн\. — її закрито/);
  const many = expiryNote(Array.from({ length: 13 }, (_, i) => proposal(UUID(i + 1), `@c${String(i).padStart(2, '0')}`)), 14);
  assert.match(many.title, /@c09 and 3 more$/);
  assert.match(many.alert.title, /@c09 і ще 3$/);
});

test('the minute tick runs the sweep; a failing sweep does not stop the queue', async () => {
  let swept = 0;
  const logs: string[] = [];
  const repo = { requeueStuck: async () => 0, claimNext: async () => null };
  const make = (fail: boolean) => new ChannelSetupService({
    pool: { query: async () => ({ rows: [] }) } as any, repo: repo as unknown as ChannelSetupRepository,
    loop: {} as any, collect: async () => { throw new Error('unused'); }, model: async () => { throw new Error('unused'); },
    state: async () => { throw new Error('unused'); }, writers: {} as never, log: (m) => logs.push(m),
    expiry: { sweep: async () => { swept++; if (fail) throw new Error('boom'); return []; } },
  });
  await make(false).tick();
  await make(true).tick();
  await make(true).idle();
  assert.equal(swept, 2);
  assert.ok(logs.some((l) => /expiry sweep failed: boom/.test(l)));
});

test('expired is closed: apply and discard answer 409 not_open; the artifact row offers no action', async () => {
  const p = proposal(UUID(1), '@a');
  const repo = { get: async (id: string) => (id === p.id ? p : null), list: async () => [p] };
  const svc = new ChannelSetupService({
    pool: { query: async () => ({ rows: [] }) } as any, repo: repo as unknown as ChannelSetupRepository,
    loop: {} as any, collect: async () => { throw new Error('unused'); }, model: async () => { throw new Error('unused'); },
    state: async () => { throw new Error('unused'); }, writers: {} as never,
  });
  const notOpen = (e: any) => e.getStatus?.() === 409 && e.getResponse?.().error === 'not_open' && /expired/.test(e.getResponse().details);
  await assert.rejects(svc.apply(p.id, { sections: ['schedule'] }), notOpen);
  await assert.rejects(svc.discard(p.id), notOpen);

  const adapter = setupAdapter({ setup: repo as any, versions: { latestMany: async () => new Map(), record: async () => 1, list: async () => [], body: async () => undefined } as any });
  const dir = { byId: new Map(), byRef: new Map(), byChannel: new Map() } as any;
  const [row] = await adapter.list({ channel: null, limit: 10 } as any, dir);
  assert.equal(row.status, 'expired');
  assert.deepEqual(adapter.actions(row, {}), []);
  const open = adapter.actions({ ...row, status: 'ready' }, {});
  assert.deepEqual(open.map((a) => a.key), ['apply', 'discard']);
});
