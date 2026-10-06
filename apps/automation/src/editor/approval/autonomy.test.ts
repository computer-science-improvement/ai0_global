/** Spec 031 T5: the owner's approve ⇄ live switch, the "ready for autonomy" signal and promo slots in approval mode. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException } from '@nestjs/common';
import type { ChannelMode, EditorCard } from '../card';
import { makeCard } from '../post/testing/fixtures';
import { computeApprovalStats, type ApprovalDecisionRow } from './approval-stats';
import {
  AutonomyService, READY_DEDUP_DAYS, ReadyForAutonomy, isReadyForAutonomy, readyForAutonomyText,
} from './autonomy';
import { PromoExecutor } from '../promo/promo-executor';
import { ApprovalPublisher } from './approval-publisher';
import { CUTOVER_TARGET_MODE, scheduleChangeNeedsCard, variantGroupKey } from './approval-policy';

const NOW = new Date('2030-04-10T12:00:00Z');

function service(o: { mode?: ChannelMode; cardMode?: ChannelMode; waiting?: Array<{ id: string; lintWarnings?: string[] }>; conflict?: string[] } = {}) {
  const state = { mode: o.mode ?? 'approve' as ChannelMode, waiting: [...(o.waiting ?? [])] };
  const calls: Array<[string, ...unknown[]]> = [];
  const card = makeCard({ channelKey: '@chan', mode: o.cardMode ?? state.mode });
  const svc = new AutonomyService({
    stats: { report: async (f: any) => { calls.push(['report', f.channel, f.days]); return { totals: { ...computeApprovalStats([]), waiting: state.waiting.length }, byResource: [] } as any; } },
    card: async (k) => (k === '@chan' ? { ...card, mode: o.cardMode ?? state.mode } : null),
    mode: async () => state.mode,
    setMode: async (k, m) => { calls.push(['setMode', k, m]); state.mode = m; },
    waiting: async () => state.waiting,
    approve: async (id) => {
      if (o.conflict?.includes(id)) throw new ConflictException({ error: 'already_decided' });
      calls.push(['approve', id]);
      state.waiting = state.waiting.filter((w) => w.id !== id);
    },
    now: () => NOW,
  });
  return { svc, calls, state };
}

test('approve → live with "approve the waiting posts too" (the default): clean posts approved, warnings and lost races left', async () => {
  const { svc, calls, state } = service({ waiting: [{ id: 'a' }, { id: 'b', lintWarnings: ['довгий підпис'] }, { id: 'c' }, { id: 'd' }], conflict: ['d'] });
  const r = await svc.switchMode({ channel: '@chan', mode: 'live' });
  assert.equal(state.mode, 'live');
  assert.deepEqual(calls.filter((c) => c[0] !== 'report'), [['setMode', '@chan', 'live'], ['approve', 'a'], ['approve', 'c']]);
  assert.deepEqual(
    { from: r.from, to: r.to, changed: r.changed, approved: r.approved, warn: r.skippedWithWarnings, conflicts: r.conflicts, left: r.leftWaiting },
    { from: 'approve', to: 'live', changed: true, approved: 2, warn: 1, conflicts: 1, left: 2 });
});

test('approve → live without approving: the waiting posts keep waiting (they expire on their own)', async () => {
  const { svc, calls } = service({ waiting: [{ id: 'a' }, { id: 'b' }] });
  const r = await svc.switchMode({ resource: 'telegram:@chan', mode: 'live', approve_waiting: false });
  assert.equal(r.approved, 0);
  assert.equal(r.leftWaiting, 2);
  assert.ok(!calls.some((c) => c[0] === 'approve'));
});

test('live → approve is one call; switching to the current mode changes nothing', async () => {
  const live = service({ mode: 'live', waiting: [] });
  const r = await live.svc.switchMode({ channel: '@chan', mode: 'approve' });
  assert.deepEqual([r.from, r.to, r.changed], ['live', 'approve', true]);
  assert.equal(live.state.mode, 'approve');
  const again = await live.svc.switchMode({ channel: '@chan', mode: 'approve' });
  assert.equal(again.changed, false);
});

test('the card says live but the orchestrator holds approve: the switch still sets both', async () => {
  const { svc, calls } = service({ mode: 'approve', cardMode: 'live' });
  const r = await svc.switchMode({ channel: '@chan', mode: 'live', approve_waiting: false });
  assert.equal(r.changed, true);
  assert.deepEqual(calls.find((c) => c[0] === 'setMode'), ['setMode', '@chan', 'live']);
});

test('switch input: platform resources follow their network; only live/approve; unknown channel 404', async () => {
  const { svc } = service();
  await assert.rejects(svc.switchMode({ resource: 'instagram:123', mode: 'live' }), (e: any) => e.response?.error === 'resource_follows_network');
  await assert.rejects(svc.switchMode({ channel: '@chan', mode: 'shadow' }), (e: any) => e.response?.error === 'invalid_body');
  await assert.rejects(svc.switchMode({ channel: '@chan', mode: 'live', extra: 1 }), (e: any) => e.response?.error === 'invalid_body');
  await assert.rejects(svc.switchMode({ channel: '@nope', mode: 'live' }), (e: any) => e.response?.error === 'channel_not_found');
});

test('preview: the dialog reads 14 days of the network and the waiting posts (warnings counted apart)', async () => {
  const { svc, calls } = service({ waiting: [{ id: 'a' }, { id: 'b', lintWarnings: ['x'] }] });
  const p = await svc.preview({ channel: '@chan' });
  assert.equal(p.days, 14);
  assert.deepEqual(calls[0], ['report', '@chan', 14]);
  assert.deepEqual([p.mode, p.waiting, p.waitingWithWarnings], ['approve', 2, 1]);
});

// ── "ready for autonomy" ─────────────────────────────────────────────────────

const rows = (clean: number, edited: number, rejected = 0): ApprovalDecisionRow[] => [
  ...Array.from({ length: clean }, () => ({ channelKey: '@chan', resourceRef: 'telegram:@chan', outcome: 'clean' as const, rejectReason: null, waitSeconds: 60 })),
  ...Array.from({ length: edited }, () => ({ channelKey: '@chan', resourceRef: 'telegram:@chan', outcome: 'edited' as const, rejectReason: null, waitSeconds: 60 })),
  ...Array.from({ length: rejected }, () => ({ channelKey: '@chan', resourceRef: 'telegram:@chan', outcome: 'rejected' as const, rejectReason: 'тема вчорашня', waitSeconds: null })),
];

test('threshold: ≥ 20 approved in 14 days and ≥ 90 % of them without edits — exactly at the edge counts', () => {
  assert.equal(isReadyForAutonomy(computeApprovalStats(rows(19, 0))), false, '19 approved is too few');
  assert.equal(isReadyForAutonomy(computeApprovalStats(rows(18, 2))), true, '20 approved, 18 clean = 90 %');
  assert.equal(isReadyForAutonomy(computeApprovalStats(rows(17, 3))), false, '85 %');
  assert.equal(isReadyForAutonomy(computeApprovalStats(rows(27, 3, 10))), true, 'rejections do not lower the clean share of approved posts');
});

function advisor(o: { mode?: ChannelMode; clean: number; edited: number; filedAt?: Date | null }) {
  const filed: Array<{ key: string; title: string; body: string }> = [];
  const asked: Date[] = [];
  const card = makeCard({ channelKey: '@chan', title: 'Космос', mode: o.mode ?? 'approve' });
  const r = new ReadyForAutonomy({
    cards: async () => [card],
    mode: async (c: EditorCard) => c.mode,
    stats: { report: async () => ({ totals: { ...computeApprovalStats(rows(o.clean, o.edited)), waiting: 0 } }) as any },
    filedSince: async (_k, since) => { asked.push(since); return !!o.filedAt && o.filedAt >= since; },
    file: async (c, s) => { filed.push({ key: c.channelKey, ...readyForAutonomyText(c, s) }); },
    now: () => NOW,
  });
  return { r, filed, asked };
}

test('the MANAGER signal fires only above the threshold, only in approval mode, once a week', async () => {
  const above = advisor({ clean: 19, edited: 1 });
  assert.deepEqual(await above.r.run(), ['@chan']);
  assert.match(above.filed[0].title, /Космос looks ready to work autonomously/);
  assert.match(above.filed[0].body, /20 posts approved, 19 of them without edits \(95%\)/);
  assert.equal(above.asked[0].toISOString(), new Date(NOW.getTime() - READY_DEDUP_DAYS * 86_400_000).toISOString());

  assert.deepEqual(await advisor({ clean: 17, edited: 3 }).r.run(), [], 'below 90 %');
  assert.deepEqual(await advisor({ clean: 15, edited: 0 }).r.run(), [], 'below 20 approved');
  assert.deepEqual(await advisor({ clean: 25, edited: 0, mode: 'live' }).r.run(), [], 'already autonomous');
  assert.deepEqual(await advisor({ clean: 25, edited: 0, filedAt: new Date(NOW.getTime() - 3 * 86_400_000) }).r.run(), [], 'filed 3 days ago');
  assert.deepEqual(await advisor({ clean: 25, edited: 0, filedAt: new Date(NOW.getTime() - 8 * 86_400_000) }).r.run(), ['@chan'], 'a week later again');
});

// ── 022 promo slots in approval mode (FR-009) ────────────────────────────────

function promo(mode: ChannelMode, slots: any[] = []) {
  const updates: any[] = [];
  const runs: any[] = [];
  const forwarded: any[] = [];
  const claimed: string[] = [];
  const card = makeCard({ channelKey: '@space', mode, timezone: 'Europe/Kyiv' });
  const ex = new PromoExecutor({
    plans: {
      updateSlot: async (id: string, p: any) => { updates.push([id, p]); },
      getSlot: async () => ({ status: mode === 'approve' ? 'awaiting_approval' : 'published' }) as any,
      plannedPromoBefore: async () => slots,
      claimPromoSlot: async (id: string) => { claimed.push(id); return slots.find((s) => s.id === id) ?? null; },
    },
    card: async () => card,
    catalog: { list: async () => [{ ref: 'telegram:@astro', title: 'Астро', username: 'astro' }] as any },
    profiles: { get: async () => null },
    runExecutor: async (_s, _c, note) => { runs.push(note); return { status: 'ok' } as any; },
    forward: async (...a) => { forwarded.push(a); return 1; },
    mode: async () => mode,
    cards: async () => [card],
  });
  return { ex, updates, runs, forwarded, claimed };
}

test('repost in approval mode waits for the owner with a forward render; nothing is forwarded yet', async () => {
  const p = promo('approve');
  assert.equal(await p.ex.publishPromo({ id: 's1', channelKey: '@space', promo: { kind: 'repost', post_ref: 'telegram:@astro/123' } } as any, NOW), true);
  assert.equal(p.forwarded.length, 0);
  const u = p.updates[0][1];
  assert.equal(u.status, 'awaiting_approval');
  assert.deepEqual(u.renderMessages, { kind: 'forward', fromKey: '@astro', messageId: 123 });
  assert.deepEqual(u.lintWarnings, []);
});

test('cross-promo in approval mode: the executor writes it (with the tracked link) and it counts as written', async () => {
  const p = promo('approve');
  assert.equal(await p.ex.publishPromo({ id: 's2', channelKey: '@space', promo: { kind: 'cross_promo', target_ref: 'telegram:@astro', link_url: 'https://t.me/+trk' } } as any, NOW), true);
  assert.match(p.runs[0], /https:\/\/t\.me\/\+trk/);
});

test('promo write-ahead: an approval channel writes its promo slot at the slot’s write time, not before', async () => {
  // Thu 2030-04-11 12:00 Kyiv, created Tue: written at the Wed 20:00 batch.
  const slot = { id: 'p1', channelKey: '@space', scheduledAt: new Date('2030-04-11T09:00:00Z'), createdAt: new Date('2030-04-09T08:00:00Z'), format: 'repost', topic: 'Репост', sourceHints: [], promo: { kind: 'repost', post_ref: 'telegram:@astro/7' } };
  const early = promo('approve', [slot]);
  assert.equal(await early.ex.writeAhead(new Date('2030-04-10T16:00:00Z')), 0, '19:00 Kyiv: before the batch');
  assert.deepEqual(early.claimed, []);
  const due = promo('approve', [slot]);
  assert.equal(await due.ex.writeAhead(new Date('2030-04-10T17:05:00Z')), 1, '20:05 Kyiv: the batch');
  assert.deepEqual(due.claimed, ['p1']);
  assert.equal(due.updates[0][1].status, 'awaiting_approval');
  const live = promo('live', [slot]);
  assert.equal(await live.ex.writeAhead(new Date('2030-04-10T17:05:00Z')), 0, 'live channels publish promos at their time');
});

test('approval publisher: an approved repost is forwarded at its time; a deleted source is skipped', async () => {
  const updates: any[] = [];
  const forwarded: any[] = [];
  let fail: string | null = null;
  const pub = new ApprovalPublisher({
    repo: {
      claimApprovedDue: async () => [{ id: 'r1', channelKey: '@space', approvedAt: NOW, status: 'running', renderMessages: { kind: 'forward', fromKey: '@astro', messageId: 9 } } as any],
      publishedSource: async () => false, publishedTexts: async () => [], cancelPlatformPosts: async () => {},
    },
    plans: { updateSlot: async (id: string, p: any) => { updates.push([id, p]); }, countPublishedSince: async () => 0 },
    card: async () => makeCard({ channelKey: '@space', mode: 'approve' }),
    mode: async () => 'approve',
    telegram: {} as any, platform: {} as any,
    forward: async (...a) => { if (fail) throw new Error(fail); forwarded.push(a); return 77; },
  });
  assert.deepEqual(await pub.publishDue(NOW), { published: 1, skipped: 0, failed: 0 });
  assert.deepEqual(forwarded, [['@space', '@astro', 9]]);
  assert.equal(updates[0][1].status, 'published');
  fail = 'Bad Request: message to forward not found';
  assert.deepEqual(await pub.publishDue(NOW), { published: 0, skipped: 1, failed: 0 });
  assert.match(updates.at(-1)[1].error, /source_missing/);
});

// ── extension points for 023 / 024 (FR-009) ─────────────────────────────────

test('FR-009 hooks: schedule changes need a card in approve (any size), in live only beyond 90 min; cutover → approve; variants group by idea', () => {
  assert.equal(scheduleChangeNeedsCard('approve', 15), true);
  assert.equal(scheduleChangeNeedsCard('approve', 0), true);
  assert.equal(scheduleChangeNeedsCard('live', 90), false);
  assert.equal(scheduleChangeNeedsCard('live', -91), true);
  assert.equal(scheduleChangeNeedsCard('shadow', 300), false);
  assert.equal(CUTOVER_TARGET_MODE, 'approve');
  assert.equal(variantGroupKey({ id: 's1', ideaId: 'i1' }), variantGroupKey({ id: 's2', ideaId: 'i1' }));
  assert.notEqual(variantGroupKey({ id: 's1' }), variantGroupKey({ id: 's2' }));
});
