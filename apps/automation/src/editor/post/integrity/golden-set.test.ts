/**
 * Spec 037 FR-001: the golden set. Every registered integrity check runs over the 63 posts (73 messages) of the three
 * DEV channels, 07–14.10.2026, each post with the earlier posts of its channel as `previous` and the other two
 * channels as `network`. Per labelled code:
 *   • implemented (a registered check declares it) → it must be found;
 *   • not implemented yet, or `code@Tn` (an existing check that task Tn extends) → a `todo` subtest;
 * and every finding must be labelled (no false positives), `clean: true` posts have no error at all.
 * Later tasks turn their rows on by registering a check; nothing here changes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { implementedCodes, runIntegrityChecks, timelineContexts } from './registry';
import { INTEGRITY_CODES, parseLabelCode } from './codes';
import { localStamp } from './audit-report';
import type { AuditCard, AuditPost } from './types';

interface LabelRow { expect: string[]; clean?: true; note?: string }
interface Pair { a: string; b: string; note?: string; cross_channel?: boolean }
interface Labels {
  cards: Record<string, AuditCard & { note?: string }>;
  posts: Record<string, LabelRow>;
  story_pairs: { positive: Pair[]; allowed_followup: Pair[]; negative: Pair[]; mention: Pair[] };
}

const TESTING = join(__dirname, '..', 'testing');
const fixture = JSON.parse(readFileSync(join(TESTING, 'channel-logs-2026-10.json'), 'utf8')) as {
  messages: number; channels: Array<{ channel: string; posts: number }>; posts: AuditPost[];
};
const labels = JSON.parse(readFileSync(join(TESTING, 'channel-logs-2026-10.labels.json'), 'utf8')) as Labels;
const implemented = implementedCodes();

const cardOf = (p: AuditPost): AuditCard | undefined => {
  const c = labels.cards[p.channel];
  if (!c) return undefined;
  const { note: _note, ...card } = c;
  return card;
};

test('fixture: 73 messages of three channels as 63 posts; no raw HTML, no image paths', () => {
  assert.equal(fixture.messages, 73);
  assert.equal(fixture.posts.length, 63);
  assert.deepEqual(fixture.channels.map((c) => [c.channel, c.posts]), [
    ['AI Шукає Новини | DEV', 25], ['AI Технології', 21], ['Біржа Ігор | DEV', 17],
  ]);
  assert.equal(new Set(fixture.posts.map((p) => p.id)).size, fixture.posts.length, 'ids are unique');
  const raw = JSON.stringify(fixture);
  assert.doesNotMatch(raw, /<\/?(?:div|a|br|strong|p|span|img)\b/i, 'no HTML tags');
  assert.doesNotMatch(raw, /photos\/|\.jpe?g|\.png|_thumb/i, 'no image files');
  for (const p of fixture.posts) {
    assert.match(p.publishedAt, /^2026-10-(0[7-9]|1[0-4])T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/, p.id);
    assert.equal(p.timezone, 'Europe/Kyiv');
    assert.ok(p.text || p.poll, `${p.id} has text or a poll`);
  }
});

test('labels: one row per post, known codes only, story pairs point at real posts and agree with the rows', () => {
  const ids = new Set(fixture.posts.map((p) => p.id));
  assert.deepEqual(Object.keys(labels.posts).filter((id) => !ids.has(id)), [], 'labels for posts not in the fixture');
  assert.deepEqual([...ids].filter((id) => !labels.posts[id]), [], 'posts without a label row');
  for (const [id, row] of Object.entries(labels.posts)) {
    assert.ok(row.expect.length || row.clean, `${id}: expect codes or clean: true`);
    for (const l of row.expect) {
      const { code, pendingTask } = parseLabelCode(l);
      assert.ok(INTEGRITY_CODES[code], `${id}: unknown code ${code} (add it to integrity/codes.ts)`);
      if (pendingTask) assert.ok(implemented.has(code), `${id}: ${l} — the @task marker is for codes that already exist`);
    }
    if (row.clean) {
      const errors = row.expect.map((l) => parseLabelCode(l).code).filter((c) => INTEGRITY_CODES[c].level === 'error');
      assert.deepEqual(errors, [], `${id}: clean but expects error codes`);
    }
  }
  for (const id of new Set(fixture.posts.map((p) => p.channel))) assert.ok(labels.cards[id], `card for ${id}`);

  const codes = (id: string) => labels.posts[id].expect.map((l) => parseLabelCode(l).code);
  // Owner decision 2026-10-15: hashtags are off in all three DEV channels.
  for (const p of fixture.posts) {
    assert.equal(codes(p.id).includes('hashtag_while_off'), p.hashtags.length > 0, `${p.id}: hashtag_while_off iff the post has hashtags`);
  }
  const { positive, allowed_followup, negative, mention } = labels.story_pairs;
  for (const p of [...positive, ...allowed_followup, ...negative, ...mention]) {
    assert.ok(ids.has(p.a) && ids.has(p.b), `pair ${p.a} / ${p.b}`);
    const at = (id: string) => Date.parse(fixture.posts.find((x) => x.id === id)!.publishedAt);
    assert.ok(at(p.a) < at(p.b), `pair ${p.a} / ${p.b}: a is the earlier post`);
  }
  for (const p of positive) {
    assert.ok(codes(p.b).includes(p.cross_channel ? 'story_cross_channel' : 'story_repeat'), `positive ${p.b} expects the repeat`);
  }
  for (const p of [...allowed_followup, ...negative, ...mention]) {
    assert.ok(!codes(p.b).includes('story_repeat'), `${p.b} is not a repeat of ${p.a}`);
  }
  assert.ok(positive.length >= 9 && allowed_followup.length >= 2 && negative.length >= 5);
});

for (const { post, ctx } of timelineContexts(fixture.posts, (p) => ({ card: cardOf(p) }))) {
  const row = labels.posts[post.id];
  if (!row) continue; // reported by the labels test
  test(`golden ${post.id} (${localStamp(post.publishedAt, post.timezone)})`, async (t) => {
    const findings = runIntegrityChecks(post, ctx);
    const found = new Set(findings.map((f) => f.code));
    const expected = new Set(row.expect.map((l) => parseLabelCode(l).code));

    for (const l of row.expect) {
      const { code, pendingTask } = parseLabelCode(l);
      const task = pendingTask ?? INTEGRITY_CODES[code]?.task;
      if (!implemented.has(code) || (pendingTask && !found.has(code))) {
        // No body: nothing can find it yet, so the row is listed as todo without a failure trace.
        await t.test(l, { todo: `${task}: ${pendingTask ? `extends ${code}` : 'not implemented yet'}` });
        continue;
      }
      await t.test(l, () => {
        assert.ok(!pendingTask, `${code} now fires on ${post.id}: drop the @${pendingTask} marker in the labels`);
        assert.ok(found.has(code), `${code} expected, found: ${[...found].join(', ') || 'nothing'}`);
      });
    }

    await t.test('no unlabelled findings', () => {
      const extra = findings.filter((f) => !expected.has(f.code)).map((f) => `${f.code} (${f.level}): ${f.message}`);
      assert.deepEqual(extra, [], 'a check fired where the labels expect nothing: fix the check or, if it is right, the label');
    });
    if (row.clean) {
      await t.test('clean: no error-level finding', () => {
        assert.deepEqual(findings.filter((f) => f.level === 'error').map((f) => f.code), []);
      });
    }
  });
}
