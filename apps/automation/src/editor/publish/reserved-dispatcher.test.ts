import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReservedDispatcher } from './reserved-dispatcher';
import { makeSpec } from '../post/testing/fixtures';
import type { EditorSlot } from '../repo/editor-plans.repository';

const NOW = new Date('2026-10-01T09:00:00Z');
const slot = (id: string, postSpec: unknown): EditorSlot => ({
  id, planId: 'p', channelKey: '@chan', scheduledAt: NOW, kind: 'reserved', format: 'photo', topic: 't', angle: null,
  sourceHints: [], isExperiment: false, status: 'running', attempts: 1, runId: null, publishedPostId: null, postSpec,
  renderedPreview: null, error: null,
});

function setup(slots: EditorSlot[], orders: Record<string, unknown>, opts: { lookupFails?: boolean } = {}) {
  const calls: string[] = [];
  const dispatcher = new ReservedDispatcher({
    plans: { claimDueReserved: async () => slots },
    orders: { findBySlot: async (id) => { if (opts.lookupFails) throw new Error('db down'); return (orders[id] as any) ?? null; } },
    sponsored: { publishClaimed: async (s) => { calls.push(`ad:${s.id}`); return true; } },
    manual: { publishScheduled: async (s) => { calls.push(`chat:${s.id}`); return true; } },
  });
  return { dispatcher, calls };
}

test('ad-owned slot → sponsored path; orderless slot with a valid PostSpec → manual path', async () => {
  const ad = { id: 'o1', advertiser: 'ACME', sponsorLabel: null, status: 'scheduled', creative: {} };
  const { dispatcher, calls } = setup(
    [slot('s-ad', { text: 'Реклама', format: 'text' }), slot('s-chat', makeSpec()), slot('s-ad-spec', makeSpec())],
    { 's-ad': ad, 's-ad-spec': ad },
  );
  assert.equal(await dispatcher.publishDue(NOW), 3);
  assert.deepEqual(calls, ['ad:s-ad', 'chat:s-chat', 'ad:s-ad-spec']);
});

test('orderless slot without a valid PostSpec stays on the sponsored path (which fails it as in 008)', async () => {
  const { dispatcher, calls } = setup([slot('s1', null), slot('s2', { format: 'photo' })], {});
  await dispatcher.publishDue(NOW);
  assert.deepEqual(calls, ['ad:s1', 'ad:s2']);
});

test('an order lookup failure never routes to the manual path', async () => {
  const { dispatcher, calls } = setup([slot('s1', makeSpec())], {}, { lookupFails: true });
  await dispatcher.publishDue(NOW);
  assert.deepEqual(calls, ['ad:s1']);
});
