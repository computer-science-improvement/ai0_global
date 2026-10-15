/**
 * Spec 037 T3 on a throwaway Postgres with every migration applied: an announcement recorded in its story sets
 * `editor_stories.event_at` and the event (no migration: `entities.event`); later posts keep it; 2 h after the event
 * the channel's prompts get "recap needed"; 24 h after it with no post the event is uncovered (Inbox watch, MANAGER
 * digest `event_not_covered`); a recap clears both. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { StoryRegistry } from './story.repository';
import { StoryEventRepository } from './story-event.repository';
import { StoryContextService } from './story-service';
import { EventRecapWatch } from './event-watch';
import { assessStory } from './story-match';
import { MONTHS_GENITIVE } from '../post/dates';
import { localDate, localTimeLabel } from '../roles/time';
import { SqlQuality } from '../manager/quality-digest';
import type { AuditPost } from '../post/integrity/types';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const A = '@pgt037t3_a';
const TZ = 'Europe/Kyiv';
let pool: Pool;
let planId: string;

async function cleanup() {
  await pool.query(`DELETE FROM agent_inbox WHERE kind = 'event_not_covered' AND ref_type = 'story_event'`);
  await pool.query(`DELETE FROM editor_stories st WHERE EXISTS (SELECT 1 FROM editor_story_posts sp WHERE sp.story_id = st.id AND sp.resource_ref = $1)`, [`telegram:${A}`]);
  await pool.query(`DELETE FROM editor_slots WHERE channel_key = $1`, [A]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [A]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [A]);
}

/** A published slot with a text spec at `at`. */
async function slot(at: Date, lead: string, p: string): Promise<{ id: string; post: AuditPost }> {
  const spec = { format: 'text', title: lead, origin: 'external', body: [{ type: 'lead', text: lead }, { type: 'p', text: p }] };
  const { rows } = await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, post_spec) VALUES ($1, $2, $3, 'text', $4, 'published', $5) RETURNING id`,
    [planId, A, at, lead, JSON.stringify(spec)]);
  const id = rows[0].id;
  return { id, post: { id, channel: A, publishedAt: at.toISOString(), timezone: TZ, text: `${lead}\n\n${p}`, lead, links: [], buttons: [], hashtags: [], media: null, story: {} } };
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  await pool.query(`INSERT INTO editor_channels (channel_key, mode, formats, timezone) VALUES ($1, 'live', '{"text":1}', $2)`, [A, TZ]);
  planId = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ($1, current_date) RETURNING id`, [A])).rows[0].id;
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

test('announcement → event_at, recap needed after 2 h, uncovered after 24 h, a recap clears it', { skip }, async () => {
  const reg = new StoryRegistry(pool);
  const events = new StoryEventRepository(pool);
  const now = new Date();
  // The event started 30 h ago (on the hour, Kyiv time); it was announced two days before it.
  const ev = new Date(Math.floor((now.getTime() - 30 * 3_600_000) / 3_600_000) * 3_600_000);
  const day = localDate(ev, TZ);
  const words = `${Number(day.slice(8))} ${MONTHS_GENITIVE[Number(day.slice(5, 7)) - 1]} о ${localTimeLabel(ev, TZ)} за Києвом`;
  const ann = await slot(new Date(ev.getTime() - 48 * 3_600_000), 'Apple проведе захід «Welcome Home»',
    `Apple проведе захід «Welcome Home» ${words} у Нью-Йорку. Головна новинка — хаб HomeView для розумного дому з екраном.`);
  const a1 = assessStory(ann.post, { previous: [] });
  const rec = (await reg.record({ channelKey: A, slotId: ann.id, postedAt: new Date(ann.post.publishedAt), title: 'Apple Welcome Home', post: ann.post, assessment: a1 }))!;
  const st = (await pool.query(`SELECT event_at, entities->'event' AS event, entities->'entities' AS ents FROM editor_stories WHERE id = $1`, [rec.storyId])).rows[0];
  assert.equal(new Date(st.event_at).toISOString(), ev.toISOString());
  assert.equal(st.event.name, 'Welcome Home');
  assert.equal(st.event.all_day, false);
  assert.ok(Array.isArray(st.ents) && st.ents.length > 0, 'the story entities are kept next to the event');

  // A later post of the story (a reminder 10 h before) keeps the event in `entities`.
  const rem = await slot(new Date(ev.getTime() - 10 * 3_600_000), 'Нагадування: Apple «Welcome Home» уже скоро',
    `Apple «Welcome Home» відбудеться ${words}: покажуть хаб HomeView з екраном.`);
  const remPost = { ...rem.post, story: { kind: 'reminder' as const } };
  const a2 = assessStory(remPost, { previous: [ann.post] });
  assert.equal(a2.role, 'reminder');
  await reg.record({ channelKey: A, slotId: rem.id, postedAt: new Date(rem.post.publishedAt), title: 'Нагадування', post: remPost, assessment: a2, story: { kind: 'reminder' } });
  assert.equal((await pool.query(`SELECT entities->'event'->>'name' AS n, event_at FROM editor_stories WHERE id = $1`, [rec.storyId])).rows[0].n, 'Welcome Home');

  // Recap needed in the planner prompt (the registry the prompts read), uncovered for the watch and the digest.
  const block = (await new StoryContextService(reg).activeBlock({ channelKey: A, timezone: TZ }, 'planner', now))!;
  assert.match(block, /recap needed/);
  assert.match(block, /«Welcome Home»/);
  assert.match(block, /анонсовано 2 раз\(и\)/);
  const gaps = await events.gaps(now, new Date(now.getTime() - 48 * 3_600_000));
  assert.deepEqual(gaps.filter((g) => g.storyId === rec.storyId).map((g) => g.resources.map((r) => [r.ref, r.announced])), [[[`telegram:${A}`, 2]]]);
  const q = (await new SqlQuality(pool).digest([`telegram:${A}`], now)).get(`telegram:${A}`)!;
  assert.ok(q.flags.includes('event_not_covered'));
  assert.equal(q.events_not_covered?.[0].event, 'Welcome Home');

  // The watch posts one Inbox note per event (dedup on story_event ref), however often it looks.
  const posted: string[] = [];
  const inbox = {
    postOnce: async (i: { kind: string; refType: string; refId: string; title: string; body?: string | null }) => {
      const { rows } = await pool.query(
        `INSERT INTO agent_inbox (kind, title, body, ref_type, ref_id, severity) SELECT $1, $2, $3, $4, $5, 'action'
          WHERE NOT EXISTS (SELECT 1 FROM agent_inbox WHERE kind = $1 AND ref_type = $4 AND ref_id = $5) RETURNING id`,
        [i.kind, i.title, i.body ?? null, i.refType, i.refId]);
      if (rows.length) posted.push(i.title);
      return rows[0]?.id ?? null;
    },
  };
  const watch = new EventRecapWatch({ pool, inbox, everyMs: 0 });
  await watch.check(now);
  await watch.check(new Date(now.getTime() + 60_000));
  assert.deepEqual(posted, ['Announced event got no recap: «Welcome Home»']);

  // The recap (an hour after the event) clears "recap needed" and the gap.
  const recap = await slot(new Date(ev.getTime() + 3_600_000), 'Оновлення: Apple показала HomeView',
    'Оновлення: Apple показала HomeView на «Welcome Home» — 349 доларів, продажі з 24 жовтня.');
  const recapPost = { ...recap.post, story: { kind: 'followup' as const, followupOf: ann.id, newFacts: ['349 доларів'] } };
  const a3 = assessStory(recapPost, { previous: [rem.post, ann.post] });
  assert.equal(a3.role, 'followup');
  await reg.record({ channelKey: A, slotId: recap.id, postedAt: new Date(recap.post.publishedAt), title: 'Оновлення', post: recapPost, assessment: a3, story: { kind: 'followup', newFacts: ['349 доларів'] } });
  assert.equal(new Date((await pool.query(`SELECT event_at FROM editor_stories WHERE id = $1`, [rec.storyId])).rows[0].event_at).toISOString(), ev.toISOString(), 'a post after the start never moves the event');
  assert.deepEqual(await reg.recapItems(A, now), []);
  assert.deepEqual((await events.gaps(now, new Date(now.getTime() - 48 * 3_600_000))).filter((g) => g.storyId === rec.storyId), []);
});
