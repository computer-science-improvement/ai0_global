import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditPost, AuditStory } from '../post/integrity/types';
import { timelineContexts } from '../post/integrity/registry';
import { assessStory, storyMatch, storyView } from './story-match';

/** Spec 037 T2: the story matcher on the golden set (labelled pairs) and the declared follow-up / reminder rules. */

const DIR = join(__dirname, '..', 'post', 'testing');
const fixture = JSON.parse(readFileSync(join(DIR, 'channel-logs-2026-10.json'), 'utf8')) as { posts: AuditPost[] };
const labels = JSON.parse(readFileSync(join(DIR, 'channel-logs-2026-10.labels.json'), 'utf8'));
const byId = new Map(fixture.posts.map((p) => [p.id, p]));
type Pair = { a: string; b: string };
const pairs = (k: string): Pair[] => labels.story_pairs[k];
const matches = (p: Pair) => !!storyMatch(storyView(byId.get(p.b)!), storyView(byId.get(p.a)!));

test('golden set: every labelled repeat pair is one story; an allowed follow-up is not a repeat on the timeline', () => {
  for (const p of pairs('positive')) assert.ok(matches(p), `${p.a} → ${p.b}`);
  const timeline = new Map(timelineContexts(fixture.posts).map((x) => [x.post.id, x]));
  for (const p of pairs('allowed_followup')) {
    const t = timeline.get(p.b)!;
    const a = assessStory(t.post, t.ctx);
    assert.deepEqual(a.findings.filter((f) => f.level === 'error').map((f) => f.code), [], `${p.b} after ${p.a}`);
    assert.ok(a.role === 'followup' || a.role === 'reminder' || a.role === 'original', `${p.b}: ${a.role}`);
  }
});

test('golden set: unrelated pairs and a passing mention stay apart (≤ 5 % false positives)', () => {
  const neg = [...pairs('negative'), ...pairs('mention')];
  const fp = neg.filter(matches);
  assert.ok(fp.length / neg.length <= 0.05, `false positives: ${fp.map((p) => `${p.a}→${p.b}`).join(', ')}`);
});

// ── declared stories (a PostSpec says what it is) ──────────────────────────────────────────────────────────────

const TZ = 'Europe/Kyiv';
function post(id: string, at: string, text: string, story: AuditStory | undefined = {}, channel = '@ai'): AuditPost {
  return {
    id, channel, publishedAt: at, timezone: TZ, text, links: [], buttons: [], hashtags: [], media: null,
    lead: text.split('\n')[0], ...(story ? { story } : {}), messageIds: [Number(id.replace(/\D/g, '')) || 1],
  };
}

const HUB = 'Apple і LG роблять розумний дім\n\nApple Home Hub з екраном керуватиме замком, термостатом і дверним дзвінком від LG. '
  + 'Партнерство Apple та LG охоплює лінійку пристроїв для розумного будинку, презентація очікується 13 жовтня.';
const HUB_AGAIN = 'Apple Home Hub: що відомо\n\nApple Home Hub отримає екран і керуватиме пристроями розумного будинку від LG — замком, '
  + 'термостатом і дзвінком. Презентацію пристроїв чекають 13 жовтня.';
const HUB_PRICE = 'Apple Home Hub коштуватиме $349\n\nApple Home Hub вийде за $349 у листопаді: пристрій розумного будинку з екраном, '
  + 'який керуватиме замком і термостатом від LG.';

test('a retelling of the story is story_repeat; a scheduled sibling slot counts too (the later post is the repeat)', () => {
  const orig = post('s1', '2026-10-07T10:00:00+03:00', HUB);
  const again = post('s2', '2026-10-09T10:00:00+03:00', HUB_AGAIN);
  const a = assessStory(again, { previous: [orig] });
  assert.equal(a.role, 'repeat');
  assert.deepEqual(a.findings.map((f) => f.code), ['story_repeat']);
  assert.match(a.findings[0].message, /Apple і LG роблять розумний дім/);
  // An approved post scheduled for later on the resource: the post written now repeats it.
  const later = post('s3', '2026-10-10T18:00:00+03:00', HUB);
  assert.equal(assessStory(again, { previous: [later] }).role, 'repeat');
  // Outside the 14 days: a new post of the topic (a news post with its source; a sourceless one is evergreen by
  // code since spec 041 and keeps its topic for 30 days).
  assert.equal(assessStory({ ...post('s4', '2026-10-25T10:00:00+03:00', HUB_AGAIN), sourceUrl: 'https://www.apple.com/newsroom/x' }, { previous: [orig] }).role, 'original');
  // lintPost passes no history: nothing to compare with, nothing found.
  assert.deepEqual(assessStory(again, { previous: [] }).findings, []);
});

test('a follow-up needs a new fact absent from the story and present in the post; one per day; restating is a warning', () => {
  const orig = post('s1', '2026-10-07T10:00:00+03:00', HUB);
  const fu = (facts: string[] | undefined, at = '2026-10-09T10:00:00+03:00', text = HUB_PRICE) =>
    post('s9', at, text, { followupOf: 's1', kind: 'followup', ...(facts ? { newFacts: facts } : {}) });
  const ok = assessStory(fu(['ціна $349']), { previous: [orig] });
  assert.equal(ok.role, 'followup');
  assert.deepEqual(ok.findings.filter((f) => f.level === 'error'), []);
  assert.equal(ok.original?.id, 's1');

  const none = assessStory(fu(undefined), { previous: [orig] });
  assert.deepEqual(none.findings.map((f) => f.code), ['followup_without_new_facts']);
  const stale = assessStory(fu(['презентація 13 жовтня']), { previous: [orig] });
  assert.deepEqual(stale.findings.map((f) => f.code), ['followup_without_new_facts'], 'the date was in the original');
  const absent = assessStory(fu(['ціна $499']), { previous: [orig] });
  assert.deepEqual(absent.findings.map((f) => f.code), ['followup_without_new_facts'], 'the fact is not in the post');

  // One follow-up of a story per day.
  const first = post('s5', '2026-10-09T08:00:00+03:00', HUB_PRICE, { followupOf: 's1', kind: 'followup', newFacts: ['$349'] });
  const second = assessStory(fu(['листопад'], '2026-10-09T15:00:00+03:00', `${HUB_PRICE}\n\nПродажі стартують 20 листопада.`), { previous: [first, orig] });
  assert.equal(second.findings[0]?.code, 'story_repeat');
  assert.match(second.findings[0].message, /не більше одного на день/);

  // Restating most of the original is a warning for the critic.
  const restate = assessStory(post('s6', '2026-10-09T10:00:00+03:00', `${HUB}\n\nЦіна — $349.`, { followupOf: 's1', kind: 'followup', newFacts: ['$349'] }), { previous: [orig] });
  assert.deepEqual(restate.findings.map((f) => [f.code, f.level]), [['followup_restates', 'warning']]);
});

const DEAL = 'Steam роздає Out of Sight безкоштовно\n\nOut of Sight можна забрати безкоштовно в Steam до 10 жовтня 15:00. Гра залишиться у бібліотеці назавжди.';
const REMIND = 'Out of Sight ще можна забрати безкоштовно\n\nРоздача Out of Sight у Steam закривається сьогодні о 15:00 — встигніть забрати гру.';

test('a giveaway reminder: one, in the last 24 h before the end', () => {
  const orig = post('d1', '2026-10-07T12:00:00+03:00', DEAL);
  const remind = (at: string) => post('d2', at, REMIND, { followupOf: 'd1', kind: 'reminder' });
  assert.equal(assessStory(remind('2026-10-10T09:00:00+03:00'), { previous: [orig] }).role, 'reminder');
  const early = assessStory(remind('2026-10-08T12:00:00+03:00'), { previous: [orig] });
  assert.equal(early.findings[0]?.code, 'story_repeat');
  assert.match(early.findings[0].message, /останні 24 год/);
  const first = post('d3', '2026-10-10T08:00:00+03:00', REMIND, { followupOf: 'd1', kind: 'reminder' });
  const twice = assessStory(remind('2026-10-10T12:00:00+03:00'), { previous: [first, orig] });
  assert.equal(twice.findings[0]?.code, 'story_repeat');
  assert.match(twice.findings[0].message, /одне на роздачу/);
});

test('a digest may include covered stories; an evergreen topic does not come back for 30 days', () => {
  const orig = post('s1', '2026-10-07T10:00:00+03:00', HUB);
  assert.equal(assessStory(post('r1', '2026-10-09T10:00:00+03:00', HUB_AGAIN, { kind: 'roundup' }), { previous: [orig] }).role, 'roundup');
  const ever = post('e1', '2026-10-01T10:00:00+03:00', HUB, { kind: 'evergreen' });
  const back = assessStory(post('e2', '2026-10-25T10:00:00+03:00', HUB_AGAIN, { kind: 'evergreen' }), { previous: [ever] });
  assert.equal(back.findings[0]?.code, 'story_repeat');
  assert.match(back.findings[0].message, /30 днів/);
  assert.equal(assessStory(post('e3', '2026-11-05T10:00:00+03:00', HUB_AGAIN, { kind: 'evergreen' }), { previous: [ever] }).role, 'evergreen');
});

test('a sibling channel told the story in the last 72 h (041): story_cross_channel warning', () => {
  const sib = post('x1', '2026-10-07T09:00:00+03:00', HUB, {}, '@ai_tech');
  const mine = post('s1', '2026-10-07T15:00:00+03:00', HUB_AGAIN);
  const a = assessStory(mine, { previous: [], network: [sib] });
  assert.equal(a.role, 'original');
  assert.deepEqual(a.findings.map((f) => [f.code, f.level]), [['story_cross_channel', 'warning']]);
  assert.match(a.findings[0].message, /@ai_tech/);
  assert.equal(assessStory(post('s2', '2026-10-09T15:00:00+03:00', HUB_AGAIN), { previous: [], network: [sib] }).findings[0]?.code, 'story_cross_channel', '54 h later: still within 72 h');
  assert.deepEqual(assessStory(post('s3', '2026-10-10T15:00:00+03:00', HUB_AGAIN), { previous: [], network: [sib] }).findings, [], 'after 72 h the sibling does not matter');
});
