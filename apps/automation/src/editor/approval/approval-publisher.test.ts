/** Spec 037 T16: the approval publisher's dedup re-check asks every ref of the post, not only the first. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import { ApprovalPublisher } from './approval-publisher';

const NOW = new Date('2026-10-08T11:13:00Z'); // 14:13 Kyiv

function publisher(published: string[], o: { cycle?: boolean | 'absent'; earlier?: string } = {}) {
  const updates: any[] = [];
  const sent: any[] = [];
  const asked: string[] = [];
  const excluded: Array<string | null> = [];
  const spec = makeSpec({ library_ref: 'data://steam_deals/42', source: { url: 'https://store.steampowered.com/', label: 'Steam' } });
  const pub = new ApprovalPublisher({
    repo: {
      claimApprovedDue: async () => [{
        id: 's2', channelKey: '@birzha', approvedAt: NOW, status: 'running', topic: 'Знижки Steam', postSpec: spec,
        renderedPreview: 'Знижки Steam', renderMessages: { kind: 'telegram', messages: [{ method: 'sendMessage', text: 'x' }], primary: 0 },
      } as any],
      publishedSource: async (_k: string, ref: string) => { asked.push(ref); return published.includes(ref); },
      // Like the repository: an excluded library row's earlier posts are not in the corpus (spec 071 R2).
      publishedTexts: async (_k: string, _id: string, ex: string | null = null) => { excluded.push(ex); return o.earlier && !ex ? [o.earlier] : []; },
      cancelPlatformPosts: async () => {},
    },
    plans: { updateSlot: async (id: string, p: any) => { updates.push([id, p]); }, countPublishedSince: async () => 0 },
    card: async () => makeCard({ channelKey: '@birzha', mode: 'approve' }),
    mode: async () => 'approve',
    telegram: {
      plans: { insertPublication: async () => 501 },
      publisher: { send: async (_k: string, m: any) => { sent.push(m); return { messageIds: [900] }; } },
      recordPublish: () => {},
    },
    platform: {} as any,
    ...(o.cycle === 'absent' || o.cycle === undefined ? {} : { isCycleRef: async (ref: string) => ref === 'data://steam_deals/42' && o.cycle === true }),
  });
  return { pub, updates, sent, asked, excluded };
}

test('037 T16: an approved post whose source URL went out while it waited is skipped, even with a library ref', async () => {
  const h = publisher(['https://store.steampowered.com/']);
  assert.deepEqual(await h.pub.publishDue(NOW), { published: 0, skipped: 1, failed: 0 });
  assert.deepEqual(h.asked, ['data://steam_deals/42', 'https://store.steampowered.com/'], 'both refs are asked');
  assert.equal(h.sent.length, 0);
  assert.equal(h.updates[0][1].status, 'skipped');
  assert.equal(h.updates[0][1].error, 'dedup_after_approval');
});

test('037 T16: an approved post with none of its refs published goes out', async () => {
  const h = publisher([]);
  assert.deepEqual(await h.pub.publishDue(NOW), { published: 1, skipped: 0, failed: 0 });
  assert.equal(h.sent.length, 1);
  assert.equal(h.updates.at(-1)[1].status, 'published');
});

test('071 R1: a post of a dataset that repeats in rounds is re-checked by its row only — the URL it cites went out in round 1 and does not stop it', async () => {
  const h = publisher(['https://store.steampowered.com/'], { cycle: true });
  assert.deepEqual(await h.pub.publishDue(NOW), { published: 1, skipped: 0, failed: 0 });
  assert.deepEqual(h.asked, ['data://steam_deals/42'], 'the URL is not asked');
  assert.equal(h.updates.at(-1)[1].status, 'published');

  // The row itself went out in this round (the ledger says so): still skipped.
  const rowDone = publisher(['data://steam_deals/42'], { cycle: true });
  assert.deepEqual(await rowDone.pub.publishDue(NOW), { published: 0, skipped: 1, failed: 0 });
  assert.equal(rowDone.updates[0][1].error, 'dedup_after_approval');

  // The same pair under a dataset that never repeats, and with no cycle dep at all: today's check, skipped.
  for (const cycle of [false, 'absent'] as const) {
    const never = publisher(['https://store.steampowered.com/'], { cycle });
    assert.deepEqual(await never.pub.publishDue(NOW), { published: 0, skipped: 1, failed: 0 }, String(cycle));
    assert.deepEqual(never.asked, ['data://steam_deals/42', 'https://store.steampowered.com/']);
  }
});

test('071 R2: a round-2 row is not told apart from its own earlier post; under a dataset that never repeats the similarity re-check is as before', async () => {
  const same = 'Знижки Steam';
  const cycle = publisher([], { cycle: true, earlier: same });
  assert.deepEqual(await cycle.pub.publishDue(NOW), { published: 1, skipped: 0, failed: 0 });
  assert.deepEqual(cycle.excluded, ['data://steam_deals/42'], 'the repository is told which row to leave out');

  const never = publisher([], { cycle: false, earlier: same });
  assert.deepEqual(await never.pub.publishDue(NOW), { published: 0, skipped: 1, failed: 0 });
  assert.deepEqual(never.excluded, [null]);
  assert.match(never.updates[0][1].error, /dedup_after_approval/);
});
