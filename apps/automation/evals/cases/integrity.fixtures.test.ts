/**
 * Fixture sanity of the spec 037 critic cases (cases/integrity.ts) — no DB, no LLM, no network:
 *   npx tsx --test evals/cases/integrity.fixtures.test.ts
 * Every case points at a golden-fixture post, its spec parses, the context states the publish time and the story
 * posts, problem cases are labelled problems in the golden set and clean cases carry no content error there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE, INTEGRITY_CASES, INTEGRITY_CRITIC_CASES, fixturePost, integrityContext, publishLine, specOf, styledText } from './integrity';
import { parseLabelCode } from '../../src/editor/post/integrity/codes';

const labels = JSON.parse(readFileSync(join(__dirname, '../../src/editor/post/testing/channel-logs-2026-10.labels.json'), 'utf8')) as {
  posts: Record<string, { expect: string[]; clean?: true }>;
};

test('037 critic cases: unique ids, registered once, each on an @eval_int_* key', () => {
  const ids = INTEGRITY_CRITIC_CASES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(INTEGRITY_CASES.map((c) => c.id), ids);
  for (const c of INTEGRITY_CASES) assert.match(c.channel, /^@eval_int_/);
  assert.ok(INTEGRITY_CRITIC_CASES.filter((c) => c.expect === 'pass').length >= 3);
  assert.ok(INTEGRITY_CRITIC_CASES.filter((c) => c.expect === 'not_pass').length >= 10);
});

test('037 critic cases: posts exist, specs parse, story posts are earlier', () => {
  assert.equal(FIXTURE.posts.length, 63);
  for (const c of INTEGRITY_CRITIC_CASES) {
    const p = fixturePost(c.post);
    const spec = specOf(p);
    assert.ok(spec.body.length || spec.poll, c.id);
    assert.ok(!styledText(p).match(/(^|\n)#\p{L}/u), `${c.id}: hashtags dropped`);
    for (const id of [...(c.story ?? []), ...(c.companion ? [c.companion] : [])]) {
      assert.ok(Date.parse(fixturePost(id).publishedAt) <= Date.parse(p.publishedAt), `${c.id}: ${id} is not later`);
    }
  }
});

test('037 critic cases: the context states the publish time in Kyiv, the style and the story', () => {
  assert.equal(publishLine('2026-10-08T19:00:15+02:00'), 'четвер, 08.10.2026 20:00 (Europe/Kyiv)');
  const c = INTEGRITY_CRITIC_CASES.find((x) => x.id === 'critic-037-steam-repeat')!;
  const ctx = integrityContext(c);
  assert.match(ctx, /Публікація: четвер, 08\.10\.2026 15:13 \(Europe\/Kyiv\)\./);
  assert.match(ctx, /на «ви»; хештегів немає/);
  assert.match(ctx, /Попередні пости цієї історії[\s\S]*Стріляні ціни в Steam/);
  const poll = integrityContext(INTEGRITY_CRITIC_CASES.find((x) => x.id === 'critic-037-knowledge-poll-revealed')!);
  assert.match(poll, /Супровідний пост[\s\S]*LibreOffice/);
});

test('037 critic cases agree with the golden labels', () => {
  const benign = new Set(['hashtags_disabled', 'lead_too_long', 'slop_em_dash']);
  for (const c of INTEGRITY_CRITIC_CASES) {
    const codes = labels.posts[c.post].expect.map((l) => parseLabelCode(l).code);
    if (c.expect === 'pass') assert.deepEqual(codes.filter((x) => !benign.has(x)), [], `${c.id}: a clean case must not carry content problems`);
    else assert.ok(codes.some((x) => !benign.has(x)), `${c.id}: a problem case needs a labelled problem`);
  }
});
