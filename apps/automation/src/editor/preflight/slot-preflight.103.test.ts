// Spec 103 §8 row 4: the pre-flight never swaps the topic of a locked slot (the owner's, or made through the connector). A locked slot
// whose source is spent ends like any other pre-flight failure, with its code; an unlocked one is swapped as before. Fakes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlotPreflight, type PreflightDeps } from './slot-preflight';
import { makeCard } from '../post/testing/fixtures';

const NOW = new Date('2026-11-12T09:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const idea = (id: string): any => ({
  id, agentId: 'orch1', title: `Idea ${id}`, angle: 'angle', sources: [`https://news.example/${id}`],
  variants: [{ resource_ref: 'telegram:@chan', format: 'photo' }], status: 'accepted', createdAt: hoursAgo(2), expiresAt: new Date(NOW.getTime() + 86_400_000),
});
const slot = (over: any = {}): any => ({
  id: 's1', channelKey: '@chan', scheduledAt: NOW, kind: 'content', format: 'photo', topic: 'Topic', angle: null, sourceHints: ['https://news.example/a'],
  ideaId: 'a', isExperiment: false, status: 'running', attempts: 0, ...over,
});

function build() {
  const pool = new Map([idea('a'), idea('b')].map((i) => [i.id, i]));
  const retopics: any[] = [];
  const claimed: string[] = [];
  const d: PreflightDeps = {
    ledger: { check: async (_r: string, url: string) => (url.endsWith('/a') ? { used: true, status: 'published', resourceRef: 'telegram:@chan', ref: url, at: hoursAgo(30), slotId: 'old' } : { used: false }) } as any,
    hosts: { blocked: async () => null } as any,
    ideas: {
      idea: async (id) => pool.get(id) ?? null,
      accepted: async () => [...pool.values()],
      claim: async (id) => { claimed.push(id); return true; },
      release: async () => {},
    },
    retopic: async (id, p) => { retopics.push([id, p]); },
    env: () => undefined,
    freshnessHours: async () => 36,
    now: () => NOW,
  };
  return { pf: new SlotPreflight(d), retopics, claimed };
}

test('an unlocked slot whose source is spent is swapped to the next idea (as before)', async () => {
  const h = build();
  const r = await h.pf.run(slot(), makeCard());
  assert.equal(r.ok, true);
  assert.equal(h.retopics.length, 1);
  assert.equal(h.retopics[0][1].ideaId, 'b');
});

test('a locked slot whose source is spent is not swapped: no idea is claimed, nothing is rewritten, the failure carries its code', async () => {
  for (const lockedBy of ['connector', 'owner'] as const) {
    const h = build();
    const r = await h.pf.run(slot({ lockedBy }), makeCard());
    assert.equal(r.ok, false, lockedBy);
    assert.equal(!r.ok && r.code, 'preflight_source_used');
    assert.deepEqual(h.retopics, []);
    assert.deepEqual(h.claimed, []);
  }
});
