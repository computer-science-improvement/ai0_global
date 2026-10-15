import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleFeeds, feedItemOf, feedKey, feedOfSlot, FEED_MIN_ITEMS, SqlFeedFit, type FeedItem } from './feed-fit';
import { assembleQuality, QUALITY_FLAGS, withFeeds } from './quality-digest';
import { makeSpec } from '../post/testing/fixtures';

const MTP = 'https://www.marktechpost.com/2026/10/07/mistral-large-4/';

test('T9 feed fit: the feed of a slot — the post source, else the live item / feed, else a source hint', () => {
  assert.equal(feedKey(MTP), 'marktechpost.com');
  assert.equal(feedKey('feed:ai-research'), 'feed:ai-research');
  assert.equal(feedKey('https://'), null);
  assert.equal(feedKey(''), null);
  assert.equal(feedOfSlot({ post_spec: { source: { url: MTP } }, live_spec: { sources: ['https://blog.google/rss'] } }), 'marktechpost.com');
  // A rejected slot keeps no post spec: its live item, its feed, its hints.
  assert.equal(feedOfSlot({ live_spec: { sources: ['https://blog.google/rss'], item: { url: MTP } } }), 'marktechpost.com');
  assert.equal(feedOfSlot({ live_spec: { sources: ['https://blog.google/rss'] } }), 'blog.google');
  assert.equal(feedOfSlot({ source_hints: ['пошукай щось про Gemini', 'https://www.theverge.com/x'] }), 'theverge.com');
  assert.equal(feedOfSlot({}), null);
});

test('T9 feed fit: per feed the share of jargon / revise / reject items, and limit / replace from enough items', () => {
  const it = (feed: string | null, o: Partial<FeedItem> = {}): FeedItem => ({ feed, jargon: false, revise: false, reject: false, ...o });
  const feeds = assembleFeeds([
    it('marktechpost.com', { jargon: true }), it('marktechpost.com', { jargon: true, revise: true }), it('marktechpost.com', { reject: true }),
    it('marktechpost.com'),
    it('blog.google', { revise: true }), it('blog.google'), it('blog.google'), it('blog.google'),
    it('theverge.com', { jargon: true }), it('theverge.com', { jargon: true }),
    it(null, { reject: true }),
  ]);
  assert.deepEqual(feeds, [
    { feed: 'theverge.com', items: 2, jargon_over_level: 2, revise: 0, reject: 0, misfit_share: 1, suggestion: null },
    { feed: 'marktechpost.com', items: 4, jargon_over_level: 2, revise: 1, reject: 1, misfit_share: 0.75, suggestion: 'replace' },
    { feed: 'blog.google', items: 4, jargon_over_level: 0, revise: 1, reject: 0, misfit_share: 0.25, suggestion: null },
  ]);
  assert.equal(FEED_MIN_ITEMS, 3);
  assert.equal(assembleFeeds([it('a', { revise: true }), it('a', { jargon: true }), it('a'), it('a')])[0].suggestion, 'limit');
});

test('T9 feed fit: a slot row → verdicts (final and the first pass) and jargon recomputed at the resource level', () => {
  const research = makeSpec({
    format: 'text', media: [], source: { url: MTP },
    body: [{ type: 'p', text: 'Mistral Large 4 має 1,05 трлн параметрів в архітектурі MoE, на кожен токен активні 49 млрд. Доступ через API, ваги — пізніше.' }],
  });
  const row = { post_spec: research, critic: { verdict: 'pass', history: [{ verdict: 'revise' }] } };
  assert.deepEqual(feedItemOf(row, 'beginner'), { feed: 'marktechpost.com', jargon: true, revise: true, reject: false });
  assert.deepEqual(feedItemOf(row, 'expert'), { feed: 'marktechpost.com', jargon: false, revise: true, reject: false });
  assert.deepEqual(feedItemOf(row, null), { feed: 'marktechpost.com', jargon: false, revise: true, reject: false });
  assert.deepEqual(feedItemOf({ live_spec: { sources: [MTP] }, critic: { verdict: 'reject' } }, 'beginner'), { feed: 'marktechpost.com', jargon: false, revise: false, reject: true });
});

test('T9 feed fit in the digest: feeds on the quality block, feed_misfit flag (in the signature) only with a suggestion', () => {
  const base = assembleQuality({ critic: [], posts: [], owner: [], caps: { pollsPerWeek: 1, questionsPerDay: 1 } as any });
  assert.ok(QUALITY_FLAGS.includes('feed_misfit'));
  assert.equal(withFeeds(base, undefined), base);
  const ok = withFeeds(base, [{ feed: 'blog.google', items: 4, jargon_over_level: 0, revise: 1, reject: 0, misfit_share: 0.25, suggestion: null }]);
  assert.equal(ok.feeds?.length, 1);
  assert.ok(!ok.flags.includes('feed_misfit'));
  const bad = withFeeds(assembleQuality({ critic: [], posts: [], owner: [], caps: { pollsPerWeek: 1, questionsPerDay: 1 } as any }),
    [{ feed: 'marktechpost.com', items: 7, jargon_over_level: 5, revise: 2, reject: 1, misfit_share: 0.857, suggestion: 'replace' }]);
  assert.deepEqual(bad.flags, ['feed_misfit']);
  assert.deepEqual(bad.signature.flags, ['feed_misfit']);
});

test('T9 feed fit SQL: one slots query for the window, the level from the resource style, per-ref blocks', async () => {
  const calls: string[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push(sql.replace(/\s+/g, ' ').trim().slice(0, 40));
      if (/FROM editor_slots/.test(sql)) {
        assert.deepEqual(params[0], ['telegram:@ai_tech']);
        return { rows: [1, 2, 3].map(() => ({ ref: 'telegram:@ai_tech', post_spec: makeSpec({ format: 'text', media: [], source: { url: MTP }, body: [{ type: 'p', text: 'MoE, API, токени й параметри без пояснень.' }] }), critic: { verdict: 'pass' } })) };
      }
      if (/FROM resource_profiles/.test(sql)) return { rows: [{ profile: { format_prefs: { style: { audience: { level: 'beginner' } } } } }] };
      return { rows: [] };
    },
  } as any;
  const out = await new SqlFeedFit(pool).feeds(['telegram:@ai_tech'], new Date('2026-10-07T00:00:00Z'), new Date('2026-10-14T00:00:00Z'));
  assert.deepEqual(out.get('telegram:@ai_tech'), [{ feed: 'marktechpost.com', items: 3, jargon_over_level: 3, revise: 0, reject: 0, misfit_share: 1, suggestion: 'replace' }]);
  assert.deepEqual((await new SqlFeedFit(pool).feeds([], new Date(), new Date())).size, 0);
});
