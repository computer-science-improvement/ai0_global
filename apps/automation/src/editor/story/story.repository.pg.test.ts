/**
 * Spec 037 T2 on a throwaway Postgres with every migration applied (073 included): the story history (the channel's
 * written slots, the network siblings' 24 h), recording posts in their story (group scope), the active stories, the
 * reply target of an approved follow-up, the story repost (source, limits, the published_posts 'repost' row) and the
 * 30-day backfill (idempotent). Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { StoryRegistry } from './story.repository';
import { assessStory } from './story-match';
import { REPOST_COUNTS_SQL } from './repost-stats';
import { loadFormatPerformance, STORY_KPI_SAMPLE_FILTER } from '../tools/role-tools';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const A = '@pgt037t2_a';
const B = '@pgt037t2_b';
let pool: Pool;
const plans = new Map<string, string>();

const HUB = 'Apple і LG роблять розумний дім\n\nApple Home Hub з екраном керуватиме замком, термостатом і дверним дзвінком від LG. '
  + 'Партнерство Apple та LG охоплює лінійку пристроїв для розумного будинку, презентація очікується 13 жовтня.';
const OTHER = 'Новий застосунок для нотаток\n\nNotion Calendar отримав режим офлайн і синхронізацію з Outlook.';

async function cleanup() {
  await pool.query(`DELETE FROM editor_stories st WHERE EXISTS (SELECT 1 FROM editor_story_posts sp WHERE sp.story_id = st.id AND sp.resource_ref IN ($1, $2))`, [`telegram:${A}`, `telegram:${B}`]);
  await pool.query(`DELETE FROM published_posts WHERE channel_id IN ($1, $2)`, [A, B]);
  await pool.query(`DELETE FROM editor_slots WHERE channel_key IN ($1, $2)`, [A, B]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key IN ($1, $2)`, [A, B]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key IN ($1, $2)`, [A, B]);
}

/** A slot with a text spec; `messageId` publishes it (a published_posts row). */
async function slot(ch: string, hoursAgo: number, status: string, text: string, messageId?: number): Promise<string> {
  const [lead, p] = text.split('\n\n');
  const spec = { format: 'text', title: lead, origin: 'external', body: [{ type: 'lead', text: lead }, { type: 'p', text: p }] };
  const { rows } = await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, post_spec)
     VALUES ($1, $2, now() - ($3 || ' hours')::interval, 'text', $4, $5, $6) RETURNING id`,
    [plans.get(ch), ch, String(hoursAgo), lead, status, JSON.stringify(spec)]);
  const id = rows[0].id;
  if (messageId) {
    const pp = await pool.query(
      `INSERT INTO published_posts (channel_id, message_id, title, strategy_type, format, editor_slot_id, posted_at)
       VALUES ($1, $2, $3, 'editor', 'text', $4, now() - ($5 || ' hours')::interval) RETURNING id`, [ch, messageId, lead, id, String(hoursAgo)]);
    await pool.query(`UPDATE editor_slots SET published_post_id = $2 WHERE id = $1`, [id, pp.rows[0].id]);
  }
  return id;
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  for (const ch of [A, B]) {
    await pool.query(`INSERT INTO editor_channels (channel_key, mode, formats) VALUES ($1, 'live', '{"text":1}')`, [ch]);
    plans.set(ch, (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ($1, current_date) RETURNING id`, [ch])).rows[0].id);
  }
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

test('history, record, active stories, repost and backfill on the network scope', { skip }, async () => {
  const reg = new StoryRegistry(pool);
  const now = new Date();
  const sc = await reg.scopeOf(A);
  assert.equal(sc.scope, 'network');
  assert.ok(sc.siblings.includes(B) && !sc.siblings.includes(A));

  // A told the hub story 3 days ago (published, message 501); B told it 5 h ago (message 77); A has an unrelated post.
  const a1 = await slot(A, 72, 'published', HUB, 501);
  await slot(A, 30, 'published', OTHER, 502);
  const b1 = await slot(B, 5, 'published', HUB, 77);
  await slot(A, 2, 'planned', HUB); // not written: not history

  const h = await reg.history(A, null, now);
  assert.equal(h.previous.length, 2);
  assert.deepEqual(h.previous.find((p) => p.id === a1)?.messageIds, [501]);
  assert.deepEqual(h.network.map((p) => p.id), [b1]);

  // Backfill: oldest first, idempotent; B's post joins A's story (one story per group).
  assert.equal(await reg.backfill(now, 30, { channels: [A, B] }), 3);
  assert.equal(await reg.backfill(now, 30, { channels: [A, B] }), 0, 'a second run adds nothing');
  const stories = await pool.query(`SELECT st.story_key, count(sp.*)::int AS n FROM editor_stories st JOIN editor_story_posts sp ON sp.story_id = st.id
                                     WHERE sp.resource_ref IN ($1, $2) GROUP BY 1 ORDER BY 2 DESC`, [`telegram:${A}`, `telegram:${B}`]);
  assert.equal(stories.rows.length, 2);
  assert.equal(stories.rows[0].n, 2);
  const key = stories.rows[0].story_key;
  assert.match(key, /^apple-i-lg/);

  // A new A post of the story is a repeat against the history (the guard's assessment).
  const draft = { ...h.previous.find((p) => p.id === a1)!, id: 'draft', publishedAt: now.toISOString(), story: {} };
  assert.equal(assessStory(draft, { previous: h.previous, network: h.network }).role, 'repeat');

  // Active stories of A: own post + B as a sibling with its repost source.
  const act = await reg.activeStories(A, now);
  const hub = act.find((s) => s.key === key)!;
  assert.equal(hub.posts, 1);
  assert.equal(hub.originalRef, a1);
  assert.deepEqual(hub.siblings.map((s) => [s.channelKey, s.postRef]), [[B, `telegram:${B}/77`]]);

  // A follow-up slot of A, recorded while it waits for the owner: its reply target is A's original message.
  const fu = await slot(A, -3, 'awaiting_approval', `Apple Home Hub коштуватиме $349\n\nApple Home Hub вийде за $349: пристрій розумного будинку від Apple та LG.`);
  const fuPost = (await reg.history(A, null, now)).previous.find((p) => p.id === fu)!;
  const hh = await reg.history(A, fu, now);
  const a = assessStory({ ...fuPost, story: { followupOf: a1, kind: 'followup', newFacts: ['$349'] } }, { previous: hh.previous, network: [] });
  assert.equal(a.role, 'followup');
  await reg.record({ channelKey: A, slotId: fu, postedAt: new Date(fuPost.publishedAt), title: 'Apple Home Hub коштуватиме $349', post: fuPost, assessment: a, story: { newFacts: ['$349'] } });
  assert.equal(await reg.replyTargetOf(fu), 501);
  assert.equal((await pool.query(`SELECT key_facts FROM editor_stories WHERE story_key = $1`, [key])).rows[0].key_facts[0], '$349');

  // A story repost into A of B's post: source, limits, the decision row, the published_posts 'repost' row.
  const src = (await reg.repostSource(A, key, `telegram:${B}/77`))!;
  assert.equal(src.fromKey, B);
  assert.equal(await reg.repostSource(A, key, `telegram:${B}/999`), null);
  const rp = await slot(A, 0, 'published', OTHER);
  const dayStart = new Date(now.getTime() - 3_600_000);
  assert.deepEqual(await reg.repostCounts(A, src.storyId, dayStart), { story: 0, day: 0 });
  await reg.recordRepost({ channelKey: A, slotId: rp, source: src, reason: 'у сусіда повний розбір', postedAt: now });
  const ppId = await reg.recordForward({ channelKey: A, slotId: rp, fromKey: B, fromMessageId: 77, messageId: 600 });
  assert.deepEqual(await reg.repostCounts(A, src.storyId, dayStart), { story: 1, day: 1 });
  const row = (await pool.query(`SELECT strategy_type, title, source_url FROM published_posts WHERE id = $1`, [ppId])).rows[0];
  assert.deepEqual(row, { strategy_type: 'repost', title: 'Repost from @pgt037t2_b', source_url: 'https://t.me/pgt037t2_b/77' });
  const sp = (await pool.query(`SELECT role, decision, reason, repost_of, message_id FROM editor_story_posts WHERE slot_id = $1`, [rp])).rows[0];
  assert.deepEqual([sp.role, sp.decision, sp.reason, Number(sp.repost_of), Number(sp.message_id)], ['repost', 'repost', 'у сусіда повний розбір', src.storyPostId, 600]);

  // Reposts are counted apart (MANAGER) and stay out of the KPI samples.
  const counts = (await pool.query(REPOST_COUNTS_SQL, [[`telegram:${A}`], new Date(now.getTime() - 7 * 86_400_000), new Date(now.getTime() + 60_000)])).rows[0];
  assert.deepEqual([counts.own, counts.reposts], [2, 1]);
  const all = await loadFormatPerformance(pool, A, 7);
  const own = await loadFormatPerformance(pool, A, 7, { sampleFilter: STORY_KPI_SAMPLE_FILTER });
  assert.ok(all.some((r) => r.format === 'repost'));
  assert.ok(!own.some((r) => r.format === 'repost'));
});
