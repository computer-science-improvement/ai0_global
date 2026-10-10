/**
 * Spec 034 FR-012 (T7): `POST /api/editor/slots/:id/preview` behind EditorOpsService — which slots may be
 * previewed, one preview at a time per slot, background vs `?wait=true`, the stored result, and the slot page /
 * plans payload (plan, run, preview cost estimate). Fakes only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { EditorOpsService, type EditorOpsDeps } from './editor-ops.service';
import { makeCard } from '../post/testing/fixtures';
import type { EditorCard } from '../card';
import type { EditorSlot } from '../repo/editor-plans.repository';
import type { SlotPreview } from '../roles/preview-run';

const NOW = new Date('2030-05-06T09:00:00Z');

const slot = (over: Partial<EditorSlot> = {}): EditorSlot => ({
  id: 's1', planId: 'p1', channelKey: '@chan', scheduledAt: new Date('2030-05-06T15:00:00Z'), kind: 'content',
  format: 'text', topic: 'тема', angle: null, sourceHints: [], isExperiment: false, status: 'planned', attempts: 0,
  runId: null, publishedPostId: null, postSpec: null, renderedPreview: null, error: null, ...over,
});

const ready = (o: Partial<SlotPreview> = {}): SlotPreview => ({
  status: 'ready', platform: 'telegram', preview: '<b>Пост</b>', spec: { format: 'text' }, critic: null, reason: null, warnings: [],
  runId: 'run-9', costUsd: 0.004, startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), ...o,
});

function setup(o: { slots?: EditorSlot[]; card?: Partial<EditorCard>; enabled?: boolean; preview?: () => Promise<SlotPreview> } = {}) {
  const slots = new Map((o.slots ?? [slot()]).map((s) => [s.id, s]));
  const stored: Array<[string, SlotPreview | null]> = [];
  const calls: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const card = makeCard({ mode: 'live', ...o.card });
  const d: EditorOpsDeps = {
    channels: { get: async (k) => (k === card.channelKey ? { ...card, createdAt: NOW } : null), list: async () => [], upsert: async () => ({}) as any },
    plans: {
      listPlans: async () => [{ id: 'p1', channelKey: '@chan', planDate: '2030-05-06', status: 'active', rationale: 'r', runId: 'run-1', runRole: 'planner', createdAt: NOW, slots: [] }],
      slotStatusCounts: async () => [], getSlot: async (id) => slots.get(id) ?? null,
      claimSlot: async () => { calls.push('CLAIMED'); return null; }, skipPlannedSlot: async () => null,
      planOf: async (id) => ({ id, planDate: '2030-05-06', status: 'active', createdAt: NOW, runId: 'run-1', runRole: 'planner' }),
      claimPreview: async (id, now) => {
        const s = slots.get(id);
        if (!s || s.status !== 'planned' || s.previewDraft?.status === 'running') return null;
        const next = { ...s, previewDraft: { ...ready({ status: 'running', preview: null, spec: null, runId: null, costUsd: 0, finishedAt: null }), startedAt: now.toISOString() } };
        slots.set(id, next);
        return next;
      },
      setPreview: async (id, p) => { stored.push([id, p]); const s = slots.get(id)!; slots.set(id, { ...s, previewDraft: p }); },
    },
    memory: { listAll: async () => [], add: async () => 1, retireByOwner: async () => true },
    runs: { list: async () => [], get: async () => null, spendByDay: async () => [], previewEstimates: async (keys) => new Map(keys.map((k) => [k, 0.0061])) },
    runner: {
      runPlanner: async () => ({}) as any,
      runExecutor: async () => { calls.push('EXECUTED'); return {} as any; },
      runPreview: async (s) => { calls.push(`preview:${s.id}`); if (o.preview) return o.preview(); await gate; return ready(); },
    },
    registry: { all: () => [], get: () => undefined },
    skills: { list: () => [] },
    enabled: () => o.enabled ?? true,
    now: () => NOW,
  };
  return { ops: new EditorOpsService(d), slots, stored, calls, release };
}

const code = async (p: Promise<unknown>) => {
  try { await p; return null; } catch (e: any) { return [e.constructor.name, e.getResponse?.().error]; }
};

test('wait=true: the dry run\'s result is stored as the slot\'s previewDraft and returned; the slot is never claimed or executed', async () => {
  const h = setup({ preview: async () => ready() });
  const r = await h.ops.previewSlot('s1', { wait: true });
  assert.equal(r.preview.status, 'ready');
  assert.equal(r.preview.preview, '<b>Пост</b>');
  assert.deepEqual(h.stored.map(([id, p]) => [id, p?.status]), [['s1', 'ready']]);
  assert.equal(h.slots.get('s1')!.status, 'planned');
  assert.deepEqual(h.calls, ['preview:s1']);
});

test('background (default): returns the running preview at once; a second click while it runs is refused; then a new one may start', async () => {
  const h = setup();
  const r = await h.ops.previewSlot('s1', {});
  assert.equal(r.preview.status, 'running');
  assert.deepEqual(await code(h.ops.previewSlot('s1', {})), ['ConflictException', 'preview_in_progress']);
  h.release();
  await new Promise((r2) => setTimeout(r2, 5));
  assert.equal(h.stored.at(-1)?.[1]?.status, 'ready');
  const again = setup({ preview: async () => ready({ costUsd: 0.01 }) });
  assert.equal((await again.ops.previewSlot('s1', { wait: true })).preview.costUsd, 0.01);
});

test('a runner crash is stored as a failed preview, never thrown at the owner', async () => {
  const h = setup({ preview: async () => { throw new Error('boom'); } });
  const r = await h.ops.previewSlot('s1', { wait: true });
  assert.deepEqual([r.preview.status, r.preview.reason], ['failed', 'preview failed: boom']);
  assert.equal(h.stored.length, 1);
});

test('refused: editor disabled, channel off, written / live / derived / reserved slots', async () => {
  assert.deepEqual(await code(setup({ enabled: false }).ops.previewSlot('s1', {})), ['ServiceUnavailableException', 'editor_disabled']);
  assert.deepEqual(await code(setup({ card: { mode: 'off' } }).ops.previewSlot('s1', {})), ['ConflictException', 'channel_off']);
  assert.deepEqual(await code(setup({ slots: [slot({ status: 'shadowed' })] }).ops.previewSlot('s1', {})), ['ConflictException', 'slot_not_planned']);
  const live = slot({ topicMode: 'live', liveSpec: { sources: ['feed1'], brief: 'новини', max_age_hours: 6, origin: 'planner' } });
  assert.deepEqual(await code(setup({ slots: [live] }).ops.previewSlot('s1', {})), ['ConflictException', 'preview_live_slot']);
  assert.deepEqual(await code(setup({ slots: [slot({ treatment: 'adapt' })] }).ops.previewSlot('s1', {})), ['ConflictException', 'preview_derived_slot']);
  assert.deepEqual(await code(setup({ slots: [slot({ kind: 'reserved' })] }).ops.previewSlot('s1', {})), ['ConflictException', 'slot_not_runnable']);
  assert.ok(ConflictException && ServiceUnavailableException);
});

test('the slot page gets its plan (planned at / by which run) and the typical Preview cost; plans carry the run role and estimates', async () => {
  const h = setup();
  const d = await h.ops.slotDetail('s1');
  assert.deepEqual(d.plan, { id: 'p1', planDate: '2030-05-06', status: 'active', createdAt: NOW, runId: 'run-1', runRole: 'planner' });
  assert.equal(d.previewEstimateUsd, 0.0061);
  const plans = await h.ops.listPlans('2030-05-06');
  assert.equal(plans.plans[0].runRole, 'planner');
  assert.deepEqual(plans.previewEstimates, { '@chan': 0.0061 });
});
