/**
 * Fixture sanity of the spec 034 quality evals (cases/quality.ts) — no DB, no LLM, no network:
 *   npx tsx --test evals/cases/quality.fixtures.test.ts
 * The critic posts are what the cases claim (the slop post passes the phrase lint but trips the warnings; the clean
 * and the nonsense posts are lint-clean, so only the critic can tell them apart), the feeds are dated as intended
 * against the case clock, the sloppy MANAGER texts carry the signals the digest flags, and every FR-015 case is
 * registered once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSlopPhrases } from '../../src/editor/post/slop-phrases';
import { isSlopWarning } from '../../src/editor/post/slop-lint';
import { lintPost } from '../../src/editor/post/lint-post';
import { readerQuestions } from '../../src/editor/post/audience-asks';
import { closestRecent, LIVE_SIMILAR, readFeed } from '../../src/editor/live/feed-items';
import { exampleCard } from '../../src/editor/agents/content-examples';
import { ungroundedNumbers } from '../lib/graders';
import {
  CLEAN_POST, fixedSpec, LIVE_ITEMS, liveWeb, MQ_SLOPPY, MQ_TWO_QUESTIONS, NONSENSE_POST, QUALITY_CASES, ROBOT_SOURCE, SLOP_POST, STORAGE_SOURCE,
} from './quality';

const card = { ...exampleCard('telegram:@eval_critic', null), humor: 'none' as const, slang: false, readerQuestionsMax: 0 };
const slopCodes = (p: { title: string; text: string }) => lintPost(fixedSpec(p), card).warnings.map((w) => w.code).filter(isSlopWarning);

test('FR-015: the eight quality cases are registered once, each on its own @eval_* key or a shared one', () => {
  const ids = QUALITY_CASES.map((c) => c.id);
  assert.deepEqual([...ids].sort(), [
    'builder-examples-and-warnings', 'builder-fitting-formats', 'critic-rejects-nonsense', 'critic-rejects-slop',
    'executor-live-news-fresh', 'executor-voice-plain', 'manager-flags-quality', 'planner-poll-cap',
  ]);
  for (const c of QUALITY_CASES) assert.match(c.channel, /^@eval_/);
});

test('critic fixtures: the clean post is lint-clean and grounded', () => {
  assert.deepEqual(findSlopPhrases(CLEAN_POST.text), []);
  assert.deepEqual(slopCodes(CLEAN_POST), []);
  assert.deepEqual(readerQuestions(CLEAN_POST.text), []);
  assert.deepEqual(ungroundedNumbers(CLEAN_POST.text, STORAGE_SOURCE), []);
});

test('critic fixtures: the slop post has no listed phrase but ≥ 2 slop warnings (rhetorical Q&A, moral closer, …)', () => {
  assert.deepEqual(findSlopPhrases(SLOP_POST.text), [], 'a listed phrase would be a lint error before the critic');
  const codes = slopCodes(SLOP_POST);
  assert.ok(codes.length >= 2, codes.join(', '));
  assert.ok(codes.includes('slop_rhetorical_qa'), codes.join(', '));
  assert.ok(codes.includes('slop_moral_closer'), codes.join(', '));
});

test('critic fixtures: the nonsense post reads clean but contradicts the source', () => {
  assert.deepEqual(findSlopPhrases(NONSENSE_POST.text), []);
  assert.deepEqual(slopCodes(NONSENSE_POST), []);
  assert.ok(ungroundedNumbers(NONSENSE_POST.text, STORAGE_SOURCE).includes('2000'));
});

test('voice fixture: the source carries the numbers the grader checks', () => {
  assert.deepEqual(ungroundedNumbers('40 роботів, 12 000 доставок, 2 500 євро, 20 кг', ROBOT_SOURCE), []);
});

test('live fixtures: ages against the case clock; the freshest unposted item is `fresh`; the weekly feed has nothing', async () => {
  const now = new Date('2030-05-06T07:30:00Z');
  const web = liveWeb(now);
  const main = await readFeed('https://ua-it-news.example/rss', now, web.http);
  const age = Object.fromEntries(main.items.map((i) => [i.link, i.age_hours]));
  assert.equal(age[LIVE_ITEMS.posted.link], 0.5);
  assert.equal(age[LIVE_ITEMS.fresh.link], 1.5);
  assert.equal(age[LIVE_ITEMS.older.link], 4.5);
  assert.equal(age[LIVE_ITEMS.stale.link], 30);
  const posted = [LIVE_ITEMS.posted.title];
  const eligible = main.items
    .filter((i) => (i.age_hours ?? 99) <= 6 && closestRecent(i.title ?? '', posted) < LIVE_SIMILAR)
    .sort((a, b) => (a.age_hours ?? 0) - (b.age_hours ?? 0));
  assert.equal(eligible[0]?.link, LIVE_ITEMS.fresh.link);
  assert.ok(closestRecent(LIVE_ITEMS.posted.title, posted) >= LIVE_SIMILAR, 'the posted title counts as a repeat');
  const weekly = await readFeed('https://ua-it-news.example/rss-weekly', now, web.http);
  const left = weekly.items.filter((i) => (i.age_hours ?? 99) <= 6 && closestRecent(i.title ?? '', posted) < LIVE_SIMILAR);
  assert.deepEqual(left, [], 'nothing fresh and unposted → no_fresh_item');
  for (const i of Object.values(LIVE_ITEMS)) assert.equal((await web.get(i.link, {} as never)).status, 200);
});

test('MANAGER fixtures: the waiting post has two reader questions, the rejected one a listed cliché', () => {
  assert.equal(readerQuestions(MQ_TWO_QUESTIONS).length, 2);
  assert.ok(findSlopPhrases(MQ_SLOPPY).length >= 1);
});
