import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCard } from '../post/testing/fixtures';
import { PreviewSink } from '../roles/preview-run';
import { buildStoryTools, storyRepostLimits, type StoryToolDeps } from './story-tools';
import type { RepostSource } from './story.repository';

/** Spec 037 T2: request_story_repost — validation, limits, dry run, and the forward through the promo executor. */

const NOW = new Date('2026-10-09T09:00:00Z');
const SRC: RepostSource = { storyId: 'st-1', storyKey: 'apple-home-hub', storyPostId: 12, fromKey: 'ai_tech', messageId: 55, postedAt: new Date('2026-10-09T06:00:00Z') };

function harness(o: { source?: RepostSource | null; counts?: { story: number; day: number }; forward?: boolean; mode?: 'live' | 'shadow' | 'approve' } = {}) {
  const slot: any = { id: 'slot-1', channelKey: 'ai_news', status: 'running', scheduledAt: NOW, promo: null, resourceRef: null };
  const queries: any[] = [];
  const reposts: any[] = [];
  const forwards: any[] = [];
  const rows: any[] = [];
  const d: StoryToolDeps = {
    pool: { query: async (sql: string, p: unknown[]) => { queries.push([sql, p]); if (/SET promo/.test(sql)) slot.promo = JSON.parse(String(p[1])); return { rows: [] }; } } as any,
    plans: {
      getSlot: async () => ({ ...slot }),
      updateSlot: async (_id: string, p: any) => { Object.assign(slot, p); },
    },
    stories: {
      repostSource: async (_k, key, ref) => (o.source === undefined ? (key === SRC.storyKey && ref === 'telegram:ai_tech/55' ? SRC : null) : o.source),
      repostCounts: async () => o.counts ?? { story: 0, day: 0 },
      recordRepost: async (i) => { reposts.push(i); },
      recordForward: async (i) => { rows.push(i); return 700; },
    },
    ...(o.forward === false ? {} : { forward: async (to: string, from: string, id: number) => { forwards.push([to, from, id]); return 4242; } }),
    limits: { perStory: 1, perDay: 2 },
    now: () => NOW,
  };
  const tool = buildStoryTools(d)[0];
  const ctx: any = { runId: 'r', role: 'executor', channelKey: 'ai_news', slotId: 'slot-1', extras: { card: makeCard({ channelKey: 'ai_news', mode: o.mode ?? 'live' }) } };
  return { tool, ctx, slot, queries, reposts, forwards, rows };
}

const INPUT = { story_key: 'apple-home-hub', source_post_id: 'telegram:ai_tech/55', reason: 'у сусіда вже повний розбір, наш пост нічого не додасть' };

test('live: the slot becomes a story_repost promo, the forward goes out, the decision is recorded and the repost row is marked', async () => {
  const h = harness();
  const r: any = await h.tool.execute(INPUT, h.ctx);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.decision, r.story_key, r.source_post_id, r.status], ['repost', 'apple-home-hub', 'telegram:ai_tech/55', 'published']);
  assert.match(r.reason, /повний розбір/);
  assert.equal(h.slot.promo.kind, 'story_repost');
  assert.deepEqual(h.forwards, [['ai_news', 'ai_tech', 55]]);
  assert.deepEqual(h.rows, [{ channelKey: 'ai_news', slotId: 'slot-1', fromKey: 'ai_tech', fromMessageId: 55, messageId: 4242 }]);
  assert.equal(h.reposts.length, 1);
  assert.equal(h.reposts[0].source.storyPostId, 12);
});

test('approval mode: the forward waits for the owner; shadow: stored as a preview', async () => {
  const a = harness({ mode: 'approve' });
  const r: any = await a.tool.execute(INPUT, a.ctx);
  assert.equal(r.status, 'awaiting_approval');
  assert.deepEqual(a.slot.renderMessages, { kind: 'forward', fromKey: 'ai_tech', messageId: 55 });
  assert.equal(a.forwards.length, 0);
  const s = harness({ mode: 'shadow' });
  assert.equal(((await s.tool.execute(INPUT, s.ctx)) as any).status, 'shadowed');
  assert.equal(s.forwards.length, 0);
});

test('validation and limits: unknown source, stale source, ≤ 1 per story, ≤ 2 per day', async () => {
  const unknown = harness({ source: null });
  assert.equal(((await unknown.tool.execute(INPUT, unknown.ctx)) as any).error, 'story_repost_source_not_found');
  const stale = harness({ source: { ...SRC, postedAt: new Date('2026-10-07T06:00:00Z') } });
  assert.equal(((await stale.tool.execute(INPUT, stale.ctx)) as any).error, 'story_repost_stale');
  const perStory = harness({ counts: { story: 1, day: 1 } });
  assert.equal(((await perStory.tool.execute(INPUT, perStory.ctx)) as any).error, 'story_repost_limit');
  const perDay = harness({ counts: { story: 0, day: 2 } });
  const r: any = await perDay.tool.execute(INPUT, perDay.ctx);
  assert.equal(r.error, 'story_repost_daily_limit');
  assert.equal(perDay.queries.length, 0, 'nothing written on a refusal');
  assert.deepEqual(storyRepostLimits((k) => ({ EDITOR_STORY_REPOSTS_PER_STORY: '2', EDITOR_STORY_REPOSTS_PER_DAY: 'x' } as any)[k]), { perStory: 2, perDay: 2 });
});

test('dry-run Preview: stores the repost preview, writes and sends nothing', async () => {
  const h = harness();
  const sink = new PreviewSink();
  h.ctx.extras.dryRun = sink;
  const r: any = await h.tool.execute(INPUT, h.ctx);
  assert.deepEqual([r.ok, r.dry, r.decision], [true, true, 'repost']);
  assert.match((sink as any).post.preview, /Repost ai_tech\/55 into ai_news/);
  assert.equal(h.queries.length + h.forwards.length + h.reposts.length, 0);
});
