/**
 * Spec 037 T14: the post audit, pure part — the golden set round-tripped through PostSpecs gives the labelled codes,
 * the rules hash follows the registered checks, history / network contexts, idempotent fingerprints, the code
 * catalogue covers every code, the grouped view and the digest summary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTEGRITY_CHECKS } from '../post/integrity/registry';
import { INTEGRITY_CODES } from '../post/integrity/codes';
import { auditPostFromSpec } from '../post/integrity/from-post-spec';
import type { AuditPost, IntegrityCheck } from '../post/integrity/types';
import {
  auditFindings, auditPostFromPlatformSpec, fingerprintOf, findingExtra, parseSources, postExcerpt, rulesHash, telegramPostUrl,
  type AuditRow, type AuditTarget,
} from './post-audit';
import { AUDIT_FLAGS, CODE_EXPLANATIONS, auditFlagOf, catalogueEntry } from './code-catalogue';
import { groupFindings, summarise } from './post-audit.service';
import { expectedNow, goldenCard, goldenStory, loadGolden, specOfGoldenPost } from './testing/golden-specs';
import { PlatformPostSpecSchema } from '../platform/platform-spec';

const golden = loadGolden();
const fixture = { posts: golden.posts };

/** The golden posts of one channel as audit targets built from their PostSpecs (as the audit reads published slots). */
function goldenTargets(channel: string): AuditTarget[] {
  return fixture.posts.filter((p) => p.channel === channel).map((p) => ({
    post: auditPostFromSpec(specOfGoldenPost(p, goldenStory(golden, p.id)), { id: p.id, channel, publishedAt: p.publishedAt, timezone: p.timezone }),
    kind: 'slot' as const, postId: p.id,
  }));
}

const channels = [...new Set(fixture.posts.map((p) => p.channel))];

test('golden set via PostSpecs: the audit finds exactly the labelled codes the registered checks implement', () => {
  const diffs: string[] = [];
  for (const ch of channels) {
    // The other two DEV channels are the network (as the golden-set test and the story registry read it).
    const network = channels.filter((c) => c !== ch).flatMap((c) => goldenTargets(c).map((t) => t.post));
    const rows = auditFindings({ resourceRef: ch, targets: goldenTargets(ch), network, card: goldenCard(golden, ch) });
    for (const p of fixture.posts.filter((x) => x.channel === ch)) {
      const got = [...new Set(rows.filter((r) => r.postId === p.id).map((r) => r.code))].sort();
      const want = expectedNow(golden, p.id);
      if (JSON.stringify(got) !== JSON.stringify(want)) diffs.push(`${p.id}: got [${got}] want [${want}]`);
    }
  }
  assert.deepEqual(diffs, []);
});

test('every target gets the earlier posts of the resource as history (newest first) and the earlier network posts', () => {
  const seen: Array<{ id: string; previous: string[]; network: string[]; now?: string; sources?: number }> = [];
  const spy: IntegrityCheck = {
    id: 'spy', codes: ['spy'],
    run: (post, ctx) => { seen.push({ id: post.id, previous: ctx.previous.map((p) => p.id), network: (ctx.network ?? []).map((p) => p.id), now: ctx.now, sources: ctx.sources?.length }); return []; },
  };
  const mk = (id: string, at: string, channel = 'telegram:@a'): AuditPost => ({ id, channel, publishedAt: at, timezone: 'Europe/Kyiv', text: id, links: [], buttons: [], hashtags: [], media: null });
  const t = (p: AuditPost, sources?: AuditTarget['sources']): AuditTarget => ({ post: p, kind: 'slot', postId: p.id, sources });
  auditFindings({
    resourceRef: 'telegram:@a', checks: [spy],
    targets: [t(mk('b', '2026-10-10T10:00:00Z')), t(mk('a', '2026-10-09T10:00:00Z'), [{ url: 'https://x.test/1', publishedAt: '2026-10-09' }])],
    history: [mk('old', '2026-10-01T10:00:00Z')],
    network: [mk('n1', '2026-10-09T12:00:00Z', 'telegram:@b'), mk('n2', '2026-10-11T12:00:00Z', 'telegram:@b')],
  });
  assert.deepEqual(seen, [
    { id: 'a', previous: ['old'], network: [], now: '2026-10-09T10:00:00Z', sources: 1 },
    { id: 'b', previous: ['a', 'old'], network: ['n1'], now: '2026-10-10T10:00:00Z', sources: undefined },
  ]);
});

test('rows: a stable fingerprint per finding, extra fields kept, duplicates once, check_failed for a throwing check', () => {
  const p: AuditPost = { id: 's1', channel: 'telegram:@a', publishedAt: '2026-10-10T10:00:00Z', timezone: 'Europe/Kyiv', text: 'Lead\n\nBody', lead: 'Lead', links: [], buttons: [], hashtags: [], media: null };
  const story: IntegrityCheck = {
    id: 'story', codes: ['story_repeat'],
    run: () => [
      { code: 'story_repeat', level: 'error', message: 'same story', excerpt: 'Apple', ...({ matches: [{ slotId: 'x', url: 'https://t.me/a/1' }] } as object) },
      { code: 'story_repeat', level: 'error', message: 'same story', excerpt: 'Apple' },
    ],
  };
  const boom: IntegrityCheck = { id: 'boom', codes: ['x'], run: () => { throw new Error('bad'); } };
  const rows = auditFindings({ resourceRef: 'telegram:@a', targets: [{ post: p, kind: 'slot', postId: 's1', slotId: 's1', channelKey: '@a', messageId: 7, url: 'https://t.me/a/7' }], checks: [story, boom] });
  assert.deepEqual(rows.map((r) => [r.code, r.level]), [['story_repeat', 'error'], ['check_failed', 'error']]);
  assert.deepEqual(rows[0].extra, { matches: [{ slotId: 'x', url: 'https://t.me/a/1' }] });
  assert.equal(rows[0].postExcerpt, 'Lead');
  assert.equal(rows[0].postUrl, 'https://t.me/a/7');
  assert.equal(rows[0].fingerprint, fingerprintOf({ code: 'story_repeat', level: 'error', message: 'same story', excerpt: 'Apple' }));
  assert.equal(findingExtra({ code: 'a', level: 'warning', message: 'm' }), null);
});

test('rules hash: stable, changes with a new check or code', () => {
  assert.equal(rulesHash(), rulesHash(INTEGRITY_CHECKS));
  assert.match(rulesHash(), /^[0-9a-f]{16}$/);
  const extra: IntegrityCheck = { id: 'new', codes: ['story_repeat'], run: () => [] };
  assert.notEqual(rulesHash([...INTEGRITY_CHECKS, extra]), rulesHash());
  assert.notEqual(rulesHash([{ ...INTEGRITY_CHECKS[0], codes: [...INTEGRITY_CHECKS[0].codes, 'other'] }, ...INTEGRITY_CHECKS.slice(1)]), rulesHash());
  // Order of registration does not matter.
  assert.equal(rulesHash([...INTEGRITY_CHECKS].reverse()), rulesHash());
});

test('catalogue: every integrity code has an English title, explanation and fix; groups by task', () => {
  const missing = Object.keys(INTEGRITY_CODES).filter((c) => !CODE_EXPLANATIONS[c]);
  assert.deepEqual(missing, [], 'add these codes to audit/code-catalogue.ts');
  for (const [code, e] of Object.entries(CODE_EXPLANATIONS)) {
    for (const t of [e.title, e.explain, e.fix]) {
      assert.ok(t.trim().length > 3, code);
      assert.doesNotMatch(t, /[Ѐ-ӿ]/, `${code}: English only`);
    }
  }
  assert.ok(CODE_EXPLANATIONS.check_failed);
  assert.equal(auditFlagOf('story_repeat'), 'story_repeat');
  assert.equal(auditFlagOf('fact_conflict'), 'fact_conflict');
  assert.equal(auditFlagOf('number_not_in_sources'), 'fact_conflict');
  assert.equal(auditFlagOf('date_relative_mismatch'), 'date_issue');
  assert.equal(auditFlagOf('lead_too_long'), 'text_hygiene');
  assert.equal(auditFlagOf('hashtag_while_off'), 'style_violation');
  assert.equal(auditFlagOf('slop_em_dash'), null);
  assert.equal(auditFlagOf('jargon_over_level'), null);
  assert.deepEqual([catalogueEntry('stale_source').section, catalogueEntry('story_repeat').section, catalogueEntry('number_not_in_sources').section, catalogueEntry('banned_term').section],
    ['dates', 'stories', 'facts', 'lint']);
  // A code a later task adds without an entry still has a text and its task's group.
  assert.equal(catalogueEntry('brand_new_code').title, 'brand new code');
  assert.deepEqual([...AUDIT_FLAGS], ['story_repeat', 'fact_conflict', 'date_issue', 'text_hygiene', 'style_violation']);
});

test('links and excerpts: t.me links for public and private channels, the lead as the excerpt', () => {
  assert.equal(telegramPostUrl('@ai_news_dev', 1105), 'https://t.me/ai_news_dev/1105');
  assert.equal(telegramPostUrl('-1001234567890', 12), 'https://t.me/c/1234567890/12');
  assert.equal(telegramPostUrl('@ai', 12), null);
  assert.equal(telegramPostUrl('@ai_news_dev', null), null);
  const p = fixture.posts[0];
  assert.equal(postExcerpt(p), p.lead);
  assert.deepEqual(parseSources([{ url: 'https://a.test/x', published_at: '2026-10-07' }, { nope: 1 }]), [{ url: 'https://a.test/x', publishedAt: '2026-10-07', title: null }]);
  assert.equal(parseSources(null), null);
});

test('platform posts: caption, slides and hashtags as the reader sees them', () => {
  const spec = PlatformPostSpecSchema.parse({
    format: 'ig_carousel', title: 'Carousel', caption: '**Big** news, [read](https://x.test/a)', hashtags: ['ai'],
    slides: [{ title: 'One', text: 'First slide' }, { title: 'Two', text: 'Second slide' }], source: { url: 'https://x.test/' },
  });
  const p = auditPostFromPlatformSpec(spec, { id: 'platform:1', channel: 'instagram:1', publishedAt: '2026-10-10T10:00:00Z', timezone: 'Europe/Kyiv' });
  assert.equal(p.text, 'Big news, read\n\nOne\nFirst slide\n\nTwo\nSecond slide\n\n#ai');
  assert.deepEqual(p.links, [{ text: 'read', url: 'https://x.test/a' }]);
  assert.deepEqual(p.media, { kind: 'photo', count: 2 });
  assert.equal(p.sourceUrl, 'https://x.test/');
});

test('grouped view and digest summary: errors first, counts, distinct posts, flags per group', () => {
  const row = (o: Partial<AuditRow>): AuditRow => ({
    resourceRef: 'telegram:@a', channelKey: '@a', postKind: 'slot', postId: 's1', slotId: 's1', messageId: null, postUrl: null, postExcerpt: 'x',
    format: 'text', code: 'lead_too_long', level: 'warning', message: 'm', excerpt: null, extra: null, fingerprint: 'f', publishedAt: '2026-10-10T10:00:00.000Z', ...o,
  });
  const groups = groupFindings([
    row({}), row({ postId: 's2', publishedAt: '2026-10-11T10:00:00.000Z' }), row({ postId: 's2', fingerprint: 'g', level: 'error' }),
    row({ code: 'hashtag_while_off', level: 'error' }), row({ code: 'slop_em_dash' }),
  ]);
  assert.deepEqual(groups.map((g) => [g.code, g.level, g.count, g.posts]), [
    ['lead_too_long', 'error', 3, 2], ['hashtag_while_off', 'error', 1, 1], ['slop_em_dash', 'warning', 1, 1],
  ]);
  assert.equal(groups[0].items[0].postId, 's2', 'newest first');
  assert.equal(groups[0].title, 'Headline too long');
  const s = summarise(groups, { auditedAt: '2026-10-12T00:00:00.000Z', posts: 4 });
  assert.deepEqual(s.groups, { text_hygiene: 3, style_violation: 1 });
  assert.equal(s.findings, 5);
  assert.deepEqual(s.codes[0], { code: 'lead_too_long', level: 'error', n: 3, means: 'The bold first line is longer than 140 characters (over 220 is an error).' });
});
