// Spec 073 T4 (FR-004, A25, L6): switching a channel back on starts the day's replan — but only when it is not the scheduler's
// job to plan the day. A thrown `editor_disabled` / `replan_in_progress` (or a failing read) never costs the mode save.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorOpsService, type EditorOpsDeps } from './editor-ops.service';
import { makeCard } from '../post/testing/fixtures';
import type { EditorCard } from '../card';
import { RESERVED_ONLY_RATIONALE, type EditorSlot } from '../repo/editor-plans.repository';

const AFTERNOON = new Date('2026-10-29T10:00:00Z'); // 12:00 Kyiv (EET), plan hour is 6
const EARLY = new Date('2026-10-29T02:00:00Z');     // 04:00 Kyiv

const slot = (over: Partial<EditorSlot> = {}): EditorSlot => ({
  id: 's1', planId: 'p1', channelKey: '@chan', scheduledAt: new Date('2026-10-29T08:00:00Z'), kind: 'content',
  format: 'text', topic: 'тема', angle: null, sourceHints: [], isExperiment: false, status: 'skipped', attempts: 0,
  runId: null, publishedPostId: null, postSpec: null, renderedPreview: null, error: null, ...over,
} as EditorSlot);

interface Opts {
  mode?: EditorCard['mode'];
  now?: Date;
  plan?: { id: string; rationale: string | null } | null;
  slots?: EditorSlot[];
  enabled?: boolean;
  activePlanThrows?: boolean;
  hold?: boolean;
}

function setup(o: Opts = {}) {
  const cards = new Map<string, EditorCard>([['@chan', makeCard({ channelKey: '@chan', mode: o.mode ?? 'off', planHour: 6 })]]);
  const calls: string[] = [];
  const logs: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const d = {
    channels: {
      get: async (k: string) => (cards.has(k) ? { ...cards.get(k)!, createdAt: AFTERNOON } : null),
      list: async () => [...cards.values()].map((c) => ({ ...c, createdAt: AFTERNOON })),
      upsert: async (c: EditorCard) => {
        const previousMode = cards.get(c.channelKey)?.mode ?? null;
        cards.set(c.channelKey, c);
        calls.push(`upsert:${c.mode}`);
        return { card: { ...c, createdAt: AFTERNOON }, previousMode };
      },
    },
    plans: {
      listPlans: async () => [], slotStatusCounts: async () => [], getSlot: async () => null, claimSlot: async () => null, skipPlannedSlot: async () => null,
      getActivePlan: async (key: string, date: string) => {
        calls.push(`active:${key}:${date}`);
        if (o.activePlanThrows) throw new Error('db down');
        return o.plan === undefined ? { id: 'p1', rationale: 'a real plan' } : o.plan;
      },
      listSlots: async () => o.slots ?? [],
    },
    memory: { listAll: async () => [], add: async () => 1, retireByOwner: async () => true },
    runs: { list: async () => [], get: async () => null, spendByDay: async () => [] },
    runner: {
      runPlanner: async (card: EditorCard, opts: any) => { calls.push(`planner:${card.channelKey}:${JSON.stringify(opts ?? {})}`); if (o.hold) await gate; return { runId: 'rp', status: 'ok', terminalTool: 'submit_plan', totals: {} as any }; },
      runExecutor: async () => ({ runId: 'rx', status: 'ok', totals: {} as any }),
    },
    registry: { all: () => [], get: () => undefined },
    skills: { list: () => [] },
    enabled: () => o.enabled ?? true,
    now: () => o.now ?? AFTERNOON,
    log: (m: string) => logs.push(m),
  } as unknown as EditorOpsDeps;
  return { svc: new EditorOpsService(d), calls, logs, cards, release };
}

const settle = () => new Promise<void>((r) => setImmediate(r));
const planners = (calls: string[]) => calls.filter((c) => c.startsWith('planner:'));

test('off → shadow past the plan hour with a real plan and nothing left to run starts one replan, not awaited', async () => {
  const s = setup({ slots: [slot({ status: 'skipped' }), slot({ id: 's2', status: 'published' })], hold: true });
  const saved = await s.svc.upsertChannel('@chan', { mode: 'shadow' });
  assert.equal(saved.card.mode, 'shadow');
  await settle();
  assert.deepEqual(planners(s.calls), ['planner:@chan:{}'], 'the planner was started while it still runs (the save did not wait for it)');
  s.release();
});

test('a planned content slot still ahead, a reserved one or a past planned one do not count as "something left to run" the way a future content slot does', async () => {
  const ahead = setup({ slots: [slot({ status: 'planned', scheduledAt: new Date('2026-10-29T15:00:00Z') })] });
  await ahead.svc.upsertChannel('@chan', { mode: 'live' });
  await settle();
  assert.deepEqual(planners(ahead.calls), [], 'a future planned content slot: the day is not empty');

  const reservedOnly = setup({ slots: [slot({ kind: 'reserved', status: 'planned', scheduledAt: new Date('2026-10-29T15:00:00Z') })] });
  await reservedOnly.svc.upsertChannel('@chan', { mode: 'live' });
  await settle();
  assert.equal(planners(reservedOnly.calls).length, 1, 'a reserved slot is not content: the afternoon is empty');

  const pastPlanned = setup({ slots: [slot({ status: 'planned', scheduledAt: new Date('2026-10-29T08:00:00Z') })] });
  await pastPlanned.svc.upsertChannel('@chan', { mode: 'approve' });
  await settle();
  assert.equal(planners(pastPlanned.calls).length, 1, 'a planned slot whose time has passed is not "ahead"');
});

test('no active plan, or only a placeholder plan: nothing starts — the scheduler plans the day on its next tick', async () => {
  const none = setup({ plan: null });
  await none.svc.upsertChannel('@chan', { mode: 'shadow' });
  await settle();
  assert.deepEqual(planners(none.calls), []);

  const placeholder = setup({ plan: { id: 'p0', rationale: RESERVED_ONLY_RATIONALE } });
  await placeholder.svc.upsertChannel('@chan', { mode: 'shadow' });
  await settle();
  assert.deepEqual(planners(placeholder.calls), []);
});

test('replan: false (launch Start), before the plan hour, and any change that is not off → on start none', async () => {
  const noReplan = setup();
  await noReplan.svc.upsertChannel('@chan', { mode: 'shadow' }, { replan: false });
  await settle();
  assert.deepEqual(planners(noReplan.calls), []);
  assert.ok(!noReplan.calls.some((c) => c.startsWith('active:')), 'no plan read either');

  const early = setup({ now: EARLY });
  await early.svc.upsertChannel('@chan', { mode: 'shadow' });
  await settle();
  assert.deepEqual(planners(early.calls), []);

  const shadowToLive = setup({ mode: 'shadow' });
  await shadowToLive.svc.upsertChannel('@chan', { mode: 'live' });
  await settle();
  assert.deepEqual(planners(shadowToLive.calls), [], 'shadow → live is not a switch-on');

  const stillOff = setup({ mode: 'off' });
  await stillOff.svc.upsertChannel('@chan', { brief: 'новий бриф' });
  await settle();
  assert.deepEqual(planners(stillOff.calls), [], 'off → off');

  const toOff = setup({ mode: 'live' });
  await toOff.svc.upsertChannel('@chan', { mode: 'off' });
  await settle();
  assert.deepEqual(planners(toOff.calls), [], 'on → off');
});

test('a thrown editor_disabled or replan_in_progress, or a failing plan read, still saves the mode', async () => {
  const disabled = setup({ enabled: false });
  const a = await disabled.svc.upsertChannel('@chan', { mode: 'shadow' });
  await settle();
  assert.equal(a.card.mode, 'shadow');
  assert.equal(disabled.cards.get('@chan')!.mode, 'shadow');
  assert.deepEqual(planners(disabled.calls), []);
  assert.ok(disabled.logs.some((l) => /editor_disabled|EDITOR_ENABLED/.test(l)), disabled.logs.join('|'));

  // A replan already runs on the channel (the owner pressed Replan a moment ago).
  const busy = setup({ mode: 'shadow', hold: true });
  await busy.svc.replan('@chan', { wait: false });
  await busy.svc.upsertChannel('@chan', { mode: 'off' });          // off …
  const b = await busy.svc.upsertChannel('@chan', { mode: 'live' }); // … and on again, while that planner still runs
  await settle();
  assert.equal(b.card.mode, 'live');
  assert.equal(planners(busy.calls).length, 1, 'only the first planner started');
  assert.ok(busy.logs.some((l) => /replan_in_progress|skipped/.test(l)), busy.logs.join('|'));
  busy.release();

  const reads = setup({ activePlanThrows: true });
  const c = await reads.svc.upsertChannel('@chan', { mode: 'shadow' });
  assert.equal(c.card.mode, 'shadow');
  assert.ok(reads.logs.some((l) => /replan check/.test(l)));
});
