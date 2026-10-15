/** Spec 037 T16: the approval publisher's dedup re-check asks every ref of the post, not only the first. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import { ApprovalPublisher } from './approval-publisher';

const NOW = new Date('2026-10-08T11:13:00Z'); // 14:13 Kyiv

function publisher(published: string[]) {
  const updates: any[] = [];
  const sent: any[] = [];
  const asked: string[] = [];
  const spec = makeSpec({ library_ref: 'data://steam_deals/42', source: { url: 'https://store.steampowered.com/', label: 'Steam' } });
  const pub = new ApprovalPublisher({
    repo: {
      claimApprovedDue: async () => [{
        id: 's2', channelKey: '@birzha', approvedAt: NOW, status: 'running', topic: 'Знижки Steam', postSpec: spec,
        renderedPreview: 'Знижки Steam', renderMessages: { kind: 'telegram', messages: [{ method: 'sendMessage', text: 'x' }], primary: 0 },
      } as any],
      publishedSource: async (_k: string, ref: string) => { asked.push(ref); return published.includes(ref); },
      publishedTexts: async () => [], cancelPlatformPosts: async () => {},
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
  });
  return { pub, updates, sent, asked };
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
