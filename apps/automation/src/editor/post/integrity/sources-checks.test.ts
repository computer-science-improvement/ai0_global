/** Spec 037 T4: the source checks one by one, through lintPost and through the story guard. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuditContext, AuditPost } from './types';
import { groundingCheck, homepageCheck, sourceTierCheck, factConflictCheck } from './checks/sources';
import { lintPost } from '../lint-post';
import { makeCard, makeSpec } from '../testing/fixtures';
import { storyGuard } from '../../story/story-guard';

const post = (o: Partial<AuditPost> = {}): AuditPost => ({
  id: 't:1', channel: 't', publishedAt: '2026-10-14T09:31:27+03:00', timezone: 'Europe/Kyiv',
  text: 'Звичайний текст.', links: [], buttons: [], hashtags: [], media: null, ...o,
});
const none: AuditContext = { previous: [] };
const codes = (fs: Array<{ code: string; level: string }>) => fs.map((f) => `${f.code}:${f.level}`);

const GEMINI = 'Google зробив доступною Gemini 4 Argon. Модель пише тексти довжиною до 1 мільйона токенів і має 68,90% у Vals Index.';
const MTP = 'https://www.marktechpost.com/2026/10/13/google-gemini-4-argon-api-release/';

test('number_not_in_sources: silent without source text (the export audit, a lint call outside a run)', () => {
  assert.deepEqual(groundingCheck.run(post({ text: GEMINI, sourceUrl: MTP }), none), []);
  assert.deepEqual(groundingCheck.run(post({ text: GEMINI, sourceUrl: MTP }), { previous: [], sources: [{ url: MTP, title: 'x' }] }), []);
});

test('number_not_in_sources: the numbers missing from the pages read, listed; found numbers are silent', () => {
  const page = 'Gemini 4 Argon is generally available. It offers a 1M-token context window and scores 68.90% on the Vals Index.';
  assert.deepEqual(groundingCheck.run(post({ text: GEMINI, sourceUrl: MTP }), { previous: [], sources: [{ url: MTP, text: page }] }), []);
  const f = groundingCheck.run(post({ text: `${GEMINI} Ціна — $2.50 за мільйон.`, sourceUrl: MTP }), { previous: [], sources: [{ url: MTP, text: page }] });
  assert.deepEqual(codes(f), ['number_not_in_sources:warning']);
  assert.match(f[0].message, /«\$2\.50»/);
  assert.doesNotMatch(f[0].message, /68,90/);
});

test('number_not_in_sources: a statistical percentage in a post that cites nothing at all («90% побутових задач»)', () => {
  const text = 'Роль, контекст, формат.\n\nЦього достатньо для 90% побутових задач: хто говорить, що важливо, як оформити.';
  const f = groundingCheck.run(post({ text }), none);
  assert.deepEqual(codes(f), ['number_not_in_sources:warning']);
  assert.match(f[0].message, /немає джерела для «90%»/);
  assert.deepEqual(groundingCheck.run(post({ text, links: [{ text: 'x', url: 'https://example.com/a' }] }), none), [], 'a cited page');
  assert.deepEqual(groundingCheck.run(post({ text: 'Знижка 20% до неділі.' }), none), [], 'a discount is not a statistic');
});

test('source_is_homepage: a site root or a section index is an error; an article is not', () => {
  for (const u of ['https://store.steampowered.com/', 'https://itch.io/new-and-popular', 'https://store.epicgames.com/en-US/free-games']) {
    assert.deepEqual(codes(homepageCheck.run(post({ sourceUrl: u }), none)), ['source_is_homepage:error'], u);
  }
  assert.deepEqual(homepageCheck.run(post({ sourceUrl: MTP }), none), []);
  assert.deepEqual(codes(homepageCheck.run(post({ citedSourceUrl: 'https://www.ynab.com/' }), none)), ['source_is_homepage:error'], 'a button / footer source');
});

test('low_tier_claim: numbers from a "fun facts" page; numbers only on low-tier pages of the run', () => {
  const fun = 'https://faktypro.com.ua/page/20-cikavih-faktiv-pro-shtuchnij-intelekt';
  assert.deepEqual(codes(sourceTierCheck.run(post({ text: 'Понад 80% контенту на Netflix підбирає алгоритм.', sourceUrl: fun }), none)), ['low_tier_claim:warning']);
  assert.deepEqual(sourceTierCheck.run(post({ text: 'Термін придумали в 1956 році.', sourceUrl: fun }), none), [], 'no claim, only a year');
  const ctx: AuditContext = { previous: [], sources: [
    { url: 'https://techcrunch.com/2026/10/13/a/', text: 'Netflix said its recommendations drive engagement.' },
    { url: fun, text: '80% контенту на Netflix обирають за рекомендаціями.' },
  ] };
  const f = sourceTierCheck.run(post({ text: 'Понад 80% контенту на Netflix підбирає алгоритм.', sourceUrl: 'https://techcrunch.com/2026/10/13/a/' }), ctx);
  assert.deepEqual(codes(f), ['low_tier_claim:warning']);
  assert.match(f[0].message, /лише на слабких сторінках/);
});

test('source_aggregator: an aggregator page that links the primary source → "take the primary"; without page data nothing', () => {
  const ctx: AuditContext = { previous: [], sources: [{ url: MTP, text: 'x', primaryLinks: ['https://blog.google/technology/ai/gemini-4-argon/'] }] };
  const f = sourceTierCheck.run(post({ text: 'Текст.', sourceUrl: MTP }), ctx);
  assert.deepEqual(codes(f), ['source_aggregator:warning']);
  assert.match(f[0].message, /blog\.google/);
  assert.deepEqual(sourceTierCheck.run(post({ text: 'Текст.', sourceUrl: MTP }), none), []);
});

test('lintPost: grounding warnings from the run\'s sources, a homepage source blocks; fact_conflict is the story guard\'s', () => {
  const card = makeCard({ hashtags: ['космос'] });
  const spec = makeSpec({ body: [{ type: 'lead', text: 'Вебб показав туманність' }, { type: 'p', text: 'Знімок зробили з відстані 2 600 світлових років.' }] });
  const ok = lintPost(spec, card, { publishedAt: '2026-10-14T09:00:00Z', ctx: { sources: [{ url: 'https://nasa.gov/ring', text: 'The Ring Nebula lies about 2,600 light-years away.' }] } });
  assert.deepEqual(ok.warnings.filter((w) => w.code === 'number_not_in_sources'), []);
  const miss = lintPost(spec, card, { publishedAt: '2026-10-14T09:00:00Z', ctx: { sources: [{ url: 'https://nasa.gov/ring', text: 'The Ring Nebula, imaged by Webb.' }] } });
  assert.equal(miss.warnings.filter((w) => w.code === 'number_not_in_sources').length, 1);
  const home = lintPost(makeSpec({ source: { url: 'https://www.nasa.gov/' } }), card);
  assert.equal(home.ok, false);
  assert.ok(home.errors.some((e) => e.code === 'source_is_homepage'));
  assert.equal(factConflictCheck.lintEnforced, true);
});

test('story guard: fact_conflict against the registry\'s history joins the warnings for the critic', async () => {
  // A declared follow-up with new deals that repeats the RDR2 deal at another price.
  const earlier: AuditPost = post({ id: 'pp:1', publishedAt: '2026-10-08T11:13:57Z', story: {}, text: 'Steam знизив ціни на кілька великих ігор.\n\n'
    + 'Skyrim Special Edition — 64 грн замість 649, знижка 90%.\n\nThe Outlast Trials — 74 грн замість 740, знижка 90%.\n\n'
    + 'Cyberpunk 2077 — 419 грн замість 1399, знижка 70%.\n\nRed Dead Redemption 2 — 539 грн замість 1799, знижка 70%.\n\nSons Of The Forest — 374 грн замість 749, знижка 50%.' });
  const spec = makeSpec({ format: 'text', media: [], source: { url: 'https://store.steampowered.com/app/1174180' }, hashtags: [],
    body: [{ type: 'lead', text: 'Steam зібрав чотири великі знижки в одному тижні' },
      { type: 'list', items: ['Red Dead Redemption 2: 649 грн замість 2599 грн (−75%)', 'Sekiro: Shadows Die Twice GOTY: 1017 грн замість 2035 грн (−50%)',
        'ARC Raiders: 695 грн замість 1390 грн (−50%)', 'Terraria: 112 грн замість 225 грн (−50%)'] }],
    story: { followup_of: 'pp:1', kind: 'followup', new_facts: ['Terraria за 112 грн', 'ARC Raiders за 695 грн'] } });
  const r = await storyGuard({ history: async () => ({ scope: 'telegram:@chan', siblings: [], previous: [earlier], network: [] }) }, {
    channelKey: '@chan', slotId: 'slot-1', spec, card: { ...makeCard(), timezone: 'Europe/Kyiv' }, at: new Date('2026-10-09T15:00:00Z'), now: new Date('2026-10-09T15:00:00Z'),
  });
  assert.ok('ok' in r && r.ok, JSON.stringify(r));
  const fc = (r as any).warnings.filter((w: any) => w.code === 'fact_conflict');
  assert.equal(fc.length, 1);
  assert.match(fc[0].message, /649 грн замість 2599.*539 грн замість 1799/);
});
