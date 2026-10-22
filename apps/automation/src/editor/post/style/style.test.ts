import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GLOSSARY, effectiveStyle, glossaryEntries, renderStyleBlock, resourceKind, STYLE_BLOCK_LIMIT, StyleSchema, styleOfRow,
  type ResourceStyle,
} from './resource-style';
import { addressFindings, addressForms, glossaryFindings, hashtagFindings, nameFindings, personNames, textHashtags, unitFindings } from './style-rules';
import { buildStyleProposal, hashtagGroups, hashtagKey, loadProposalPosts } from './style-proposal';
import { resourceStyleOf } from './style-store';
import { lintPost } from '../lint-post';
import { makeCard, makeSpec } from '../testing/fixtures';
import { lintPlatformPost, PlatformPostSpecSchema } from '../../platform/platform-spec';
import { criticUserPrompt } from '../../critic/critic.service';
import { buildSystemPrompt } from '../../roles/prompts';
import { SkillLibrary } from '../../skills/skill-library';
import { FormatPrefsSchema, OWNER_ONLY_ON, renderFormatPrefs } from '../../agents/resource-profile';
import { cardSummary } from '../../card';
import { EditorOpsService } from '../../api/editor-ops.service';

const VY: ResourceStyle = effectiveStyle({}, { kind: 'news' });
const codes = (fs: Array<{ code: string; level: string }>) => fs.map((f) => `${f.code}:${f.level}`);

// ── schema and defaults ─────────────────────────────────────────────────────

test('T8 style: schema takes every field; prefer as a map or a list; unknown keys are refused', () => {
  const full = {
    address: 'vy', glossary: { prefer: { 'АПІ': 'API' }, ban: ['спотифай'] }, names: 'uk_translit', headline: { max_chars: 140 },
    numbers: { decimal: 'comma' }, units: 'words', hashtags: 'off', audience: { level: 'beginner' }, content_kind: 'games', freshness_hours: 72,
  };
  assert.deepEqual(StyleSchema.parse(full), full);
  assert.ok(StyleSchema.safeParse({ glossary: { prefer: [{ instead_of: 'КЛІ', use: 'CLI' }] } }).success);
  assert.ok(!StyleSchema.safeParse({ address: 'you' }).success);
  assert.ok(!StyleSchema.safeParse({ tone: 'x' }).success, 'strict');
  assert.deepEqual(glossaryEntries({ prefer: [{ instead_of: 'КЛІ', use: 'CLI' }], ban: ['спотифай'] }), [{ term: 'КЛІ', use: 'CLI' }, { term: 'спотифай' }]);
  // format_prefs carries it; an agent can never change it.
  assert.ok(FormatPrefsSchema.safeParse({ style: full }).success);
  assert.equal(OWNER_ONLY_ON.style?.({ address: 'ty' }), true);
  assert.match(renderFormatPrefs({ style: { address: 'vy', hashtags: 'off' } })!, /Стиль ресурсу: звертання «ви», хештеги вимкнено/);
});

test('T8 style: owner defaults — «ви» and the glossary everywhere, hashtags off on news and games, the owner wins', () => {
  assert.deepEqual(effectiveStyle({}, { kind: null }), { address: 'vy', glossary: DEFAULT_GLOSSARY, names: 'original', hashtags: 'vocabulary' });
  // Spec 063 FR-007: names default to the source's own spelling; the owner's choice wins.
  assert.equal(effectiveStyle({ names: 'uk_translit' }, { kind: null }).names, 'uk_translit');
  assert.equal(effectiveStyle({}, { kind: 'news' }).hashtags, 'off');
  assert.equal(effectiveStyle({}, { kind: 'games' }).hashtags, 'off');
  assert.equal(effectiveStyle({}, { kind: 'games' }).content_kind, 'games');
  assert.equal(effectiveStyle({ hashtags: 'vocabulary', address: 'ty' }, { kind: 'news' }).hashtags, 'vocabulary');
  assert.equal(effectiveStyle({ content_kind: 'evergreen' }, { kind: 'news' }).hashtags, 'vocabulary', 'the stored kind decides');
  assert.equal(effectiveStyle({ glossary: { ban: ['x'] } }, { kind: null }).glossary!.prefer, undefined, 'an owner glossary replaces the default');
});

test('T8 style: the three DEV channels resolve to news / news / games (hashtags off on all three)', () => {
  const rss = [{ id: 'f', kind: 'rss' as const, ref: 'https://techcrunch.com/feed/' }];
  const shukaie = resourceKind({ card: { title: 'AI Шукає Новини | DEV', brief: 'Свіжі новини ШІ', formats: { text: 1 }, sources: rss } });
  const tech = resourceKind({ topic: 'Новини штучного інтелекту для звичайних людей', card: { title: 'AI Технології', brief: '', formats: { text: 1 }, sources: [] } });
  const birzha = resourceKind({ card: { title: 'Біржа Ігор | DEV', brief: 'Роздачі, знижки й новини ігор', formats: { text: 1 }, sources: rss } });
  assert.deepEqual([shukaie, tech, birzha], ['news', 'news', 'games']);
  assert.equal(resourceKind({ contentKind: 'education', card: { title: 'Біржа Ігор', brief: '', formats: {}, sources: [] } }), 'education');
  assert.equal(resourceKind({ contentKind: 'general', topic: 'новини' }), null, 'an explicit kind decides news');
  assert.equal(resourceKind({ card: { title: 'Космос', brief: 'новини', formats: {}, sources: [] } }), null, 'news by brief needs RSS feeds');
});

test('T8 style: the card read joins the effective style (row without the profile join: no style)', () => {
  const row = {
    title: 'Біржа Ігор | DEV', brief: '', formats: {}, sources: [], profile_topic: null,
    format_prefs_json: { style: { names: 'original' } },
  };
  assert.deepEqual(styleOfRow(row).style, { names: 'original', address: 'vy', glossary: DEFAULT_GLOSSARY, hashtags: 'off', content_kind: 'games' });
  assert.deepEqual(styleOfRow({ title: 'x' }), {});
  assert.equal(styleOfRow({ ...row, format_prefs_json: { style: { address: 'nope' } } }).style!.address, 'vy', 'invalid stored style = not set');
});

test('T8 style: a news / games card that already has a hashtag vocabulary keeps it (an owner choice is never switched off)', () => {
  assert.equal(effectiveStyle({}, { kind: 'news', vocabulary: ['#ai'] }).hashtags, 'vocabulary');
  assert.equal(effectiveStyle({}, { kind: 'games', vocabulary: [] }).hashtags, 'off', 'an empty vocabulary (the DEV channels) stays off');
  assert.equal(effectiveStyle({ hashtags: 'off' }, { kind: 'news', vocabulary: ['#ai'] }).hashtags, 'off', 'an explicit owner style wins');
  const row = { title: 'Біржа Ігор', brief: '', formats: {}, sources: [], profile_topic: null, format_prefs_json: {}, hashtags: ['#роздача'] };
  assert.equal(styleOfRow(row).style!.hashtags, 'vocabulary');
});

// ── prompts ─────────────────────────────────────────────────────────────────

test('T8 prompts: a compact style block (≤ 600) with «Хештеги не став» in the writer and the critic prompts', () => {
  const style: ResourceStyle = { ...VY, names: 'uk_translit', units: 'words', numbers: { decimal: 'comma' }, headline: { max_chars: 140 }, audience: { level: 'beginner' } };
  const block = renderStyleBlock(style)!;
  assert.ok(block.length <= STYLE_BLOCK_LIMIT, `${block.length}`);
  assert.match(block, /Хештеги не став/);
  assert.match(block, /на «ви»/);
  assert.match(block, /API, не АПІ/);
  const long = renderStyleBlock({ ...style, glossary: { ban: Array.from({ length: 80 }, (_, i) => `слово${i}`) } })!;
  assert.ok(long.length <= STYLE_BLOCK_LIMIT && long.endsWith('…'));
  assert.equal(renderStyleBlock({}), null);

  const lib = new SkillLibrary();
  const card = makeCard({ style });
  assert.match(buildSystemPrompt('executor', card, [], lib), /## Стиль ресурсу[\s\S]*Хештеги не став/);
  assert.doesNotMatch(buildSystemPrompt('planner', card, [], lib), /## Стиль ресурсу/);
  assert.match(JSON.stringify(cardSummary(card)), /вимкнено: хештегів не став/);
  const critic = criticUserPrompt({
    channelKey: '@chan', slotId: 's1', mode: 'live', resourceRef: 'telegram:@chan', platform: 'telegram', format: 'text',
    text: 'x', spec: {}, voice: { style }, slopWarnings: [],
  });
  assert.match(critic, /## Стиль ресурсу[\s\S]*Хештеги не став/);
  assert.doesNotMatch(criticUserPrompt({
    channelKey: null, slotId: null, mode: 'draft', resourceRef: 'telegram:@chan', platform: 'telegram', format: 'text', text: 'x', spec: {}, voice: {}, slopWarnings: [],
  }), /Стиль ресурсу/);
});

// ── address ─────────────────────────────────────────────────────────────────

test('T8 address: both forms → error; the other form → warning; quotes, names and impersonal text → nothing', () => {
  const mixed = addressFindings('Якщо інтерактив дратує — його вимикаєш. Спитаєте про велосипед — отримаєте схему.', VY);
  assert.deepEqual(codes(mixed), ['address_mixed:error']);
  assert.match(mixed[0].message, /вимикаєш.*Спитаєте/);
  assert.deepEqual(codes(addressFindings('DMZ — це шутер. Висаджуєшся на карті, збираєш лут.', VY)), ['address_mixed:warning']);
  assert.deepEqual(codes(addressFindings('Цього тижня Epic роздає дві гри 😄\n\nПризнавайся, як у тебе з роздачами', VY)), ['address_mixed:warning']);
  assert.deepEqual(codes(addressFindings('Ви граєте за хлопчика. Забирайте гру, поки безкоштовна.', VY)), []);
  // Quoted prompts and speech are somebody else's words.
  assert.deepEqual(addressFindings('Погано: «Напиши текст про біг». Добре: «Ти тренер із бігу». Скажіть, хто відповідає.', VY), []);
  assert.deepEqual(addressFindings('«Вони будуть добре вас знати», — пояснив Фелдман.', { address: 'impersonal' }), []);
  // Impersonal text, participles in -ите, nouns in -іть, «навіть», a city in -еш.
  assert.deepEqual(addressForms('Передзамовлення вже відкрите. Минуло два століття, і навіть у Бангладеш можна купити гру.'), { ty: [], vy: [] });
  assert.deepEqual(addressFindings('Компанія показала ноутбук. Купити його можна з 16 жовтня.', VY), []);
  // The resource's own form passes; impersonal resources warn on any form.
  assert.deepEqual(addressFindings('Забирай, поки безкоштовно.', { address: 'ty' }), []);
  assert.deepEqual(codes(addressFindings('Забирайте, поки безкоштовно.', { address: 'ty' })), ['address_mixed:warning']);
  assert.deepEqual(codes(addressFindings('Забирайте, поки безкоштовно.', { address: 'impersonal' })), ['address_mixed:warning']);
  assert.deepEqual(addressFindings('Забирай, поки безкоштовно.', {}), [], 'no style: only the mix is checked');
});

// ── glossary ────────────────────────────────────────────────────────────────

test('T8 glossary: banned forms with the right one, word-bounded, hashtags count, links do not', () => {
  const f = glossaryFindings('Разом AI випустила Together Link. Хмара через АПІ або КЛІ.', VY);
  assert.deepEqual(f.map((x) => x.message), [
    'глосарій ресурсу: «АПІ» → пиши «API»', 'глосарій ресурсу: «КЛІ» → пиши «CLI»', 'глосарій ресурсу: «Разом AI» → пиши «Together AI»',
  ]);
  assert.ok(f.every((x) => x.level === 'error'));
  assert.equal(glossaryFindings('#спотифай #аудіокниги', VY).length, 1);
  assert.equal(glossaryFindings('Новини Спотифаю', VY).length, 1, '* = the rest of a word');
  assert.deepEqual(glossaryFindings('Капітал і клієнти; деталі на https://example.com/api-spotifай', VY), []);
  assert.deepEqual(glossaryFindings('ШІ і AI в одному тексті', VY), [], 'no ШІ/AI rule');
  assert.deepEqual(codes(glossaryFindings('Це фіча', { glossary: { ban: ['фіча'] } })), ['glossary_violation:error']);
  assert.deepEqual(glossaryFindings('АПІ', {}), [], 'no glossary, nothing');
});

// ── names ───────────────────────────────────────────────────────────────────

test('T8 names: Latin names with uk_translit, transliterated foreign names with original; products are not names', () => {
  const text = 'Друга причина — контроль над стеком і власними моделями, — каже керівник Mustafa Suleyman. Чипи на базі Grace Blackwell і Claude Code працюють у дата-центрах компанії.';
  assert.deepEqual(personNames(text).latin, ['Mustafa Suleyman']);
  assert.deepEqual(codes(nameFindings(text, { names: 'uk_translit' })), ['name_script_mixed:warning']);
  assert.deepEqual(nameFindings(text, { names: 'original' }), []);
  const cyr = 'Так вважає CEO Cerebras Ендрю Фелдман: асистент удома стане звичайною річчю, як побутова техніка.';
  assert.deepEqual(codes(nameFindings(cyr, { names: 'original' })), ['name_script_mixed:warning']);
  assert.deepEqual(nameFindings(cyr, { names: 'uk_translit' }), []);
  assert.deepEqual(nameFindings('Марк Гурман з Bloomberg пише про новий хаб і його ціну для покупців.', { names: 'original' }), [], 'a Ukrainian first name');
  assert.deepEqual(nameFindings(text, {}), [], 'no policy, nothing');
});

// ── units ───────────────────────────────────────────────────────────────────

test('T8 units: «49B», «270M» in words mode; model names and resolutions stay', () => {
  const f = unitFindings('Співвідношення 1,05T/49B. Модульна вага: 270M для тексту. Відкрита 12B модель на 7B-архітектурі.', { units: 'words' });
  assert.deepEqual(codes(f), ['units_latin:warning']);
  assert.match(f[0].message, /1,05T, 49B, 270M, 12B/);
  assert.deepEqual(unitFindings('Ваги d1-3B і d1-omni-600M, Qwen3.8-27B, Saluki 27B і Gemma 3 27B; роздільність 2K, 4K.', { units: 'words' }), []);
  assert.deepEqual(unitFindings('270M', { units: 'latin' }), []);
  assert.deepEqual(unitFindings('270M', {}), []);
});

// ── hashtags ────────────────────────────────────────────────────────────────

test('T8 hashtags: off → any hashtag is an error (the tag line or the text); links, code, #1 and C# are not hashtags', () => {
  assert.deepEqual(codes(hashtagFindings('Текст', ['apple'], { hashtags: 'off' })), ['hashtag_while_off:error']);
  assert.deepEqual(codes(hashtagFindings('Текст про #гаджети', [], { hashtags: 'off' })), ['hashtag_while_off:error']);
  assert.deepEqual(textHashtags('Навіть «#1 trending» на https://hf.co/#top, мова C# і `#include`'), []);
  assert.deepEqual(hashtagFindings('Текст про #гаджети', ['apple'], { hashtags: 'vocabulary' }), []);
  assert.deepEqual(hashtagFindings('Текст', ['apple'], {}), []);
});

// ── lintPost and the platform lint ──────────────────────────────────────────

test('T8 lintPost: hashtags off — no count rule, any hashtag blocks; address and glossary from card.style', () => {
  const style: ResourceStyle = { ...VY };
  const clean = lintPost(makeSpec({ hashtags: [] }), makeCard({ style, hashtagMin: 1 }));
  assert.ok(!clean.errors.some((e) => e.code === 'hashtag_count'), JSON.stringify(clean.errors));
  assert.ok(!clean.errors.some((e) => e.code === 'hashtag_while_off'));
  const tagged = lintPost(makeSpec({ hashtags: ['космос'] }), makeCard({ style }));
  assert.ok(tagged.errors.some((e) => e.code === 'hashtag_while_off'));
  const mixed = lintPost(makeSpec({
    hashtags: [],
    body: [{ type: 'lead', text: 'Телескоп показав туманність' }, { type: 'p', text: 'Забирай знімок собі. Ви побачите оболонки газу через АПІ NASA.' }],
  }), makeCard({ style }));
  assert.ok(mixed.errors.some((e) => e.code === 'address_mixed'), JSON.stringify(mixed.errors));
  assert.ok(mixed.errors.some((e) => e.code === 'glossary_violation'));
  // Without a style (an old card) nothing changes.
  assert.ok(lintPost(makeSpec({ hashtags: [] }), makeCard()).errors.some((e) => e.code === 'hashtag_count'));
});

test('T8 platform lint: the same address and glossary rules from the context or voice.style', () => {
  const spec = PlatformPostSpecSchema.parse({
    format: 'ig_carousel', title: 'Пʼять фактів про Марс', caption: 'Марс — червона планета. Гортай слайди, а дані беріть через АПІ NASA.',
    hashtags: ['космос'], slides: [{ title: 'Марс', text: 'Доба — 24 год 37 хв.' }, { title: 'Олімп', text: 'Найвища гора.' }],
  });
  const viaVoice = lintPlatformPost(spec, { platform: 'instagram', voice: { style: VY } });
  assert.deepEqual(viaVoice.errors.map((e) => e.code).sort(), ['address_mixed', 'glossary_violation']);
  const viaStyle = lintPlatformPost({ ...spec, caption: 'Гортай слайди про Марс.' }, { platform: 'instagram', style: VY });
  assert.deepEqual(viaStyle.warnings.filter((w) => w.code === 'address_mixed').length, 1);
  assert.ok(viaStyle.ok);
  // Without a style only the mix of «ти» and «ви» is checked (no glossary).
  assert.deepEqual(lintPlatformPost(spec, { platform: 'instagram' }).errors.map((e) => e.code), ['address_mixed']);
});

// ── bootstrap proposal ──────────────────────────────────────────────────────

test('T8 proposal: hashtag variants merge (роздачі → роздача, open_source → opensource); ШІ and AI stay apart', () => {
  assert.equal(hashtagKey('роздачі'), hashtagKey('роздача'));
  assert.equal(hashtagKey('#open_source'), hashtagKey('opensource'));
  assert.notEqual(hashtagKey('ші'), hashtagKey('ai'));
  const groups = hashtagGroups([
    { text: '', hashtags: ['роздача', 'steam'] }, { text: '', hashtags: ['роздачі'] }, { text: 'x #роздача', hashtags: ['роздача'] },
    { text: '', hashtags: ['open_source', 'ai'] }, { text: '', hashtags: ['opensource', 'ші'] },
  ]);
  const by = Object.fromEntries(groups.map((g) => [g.tag, g.count]));
  assert.deepEqual(by, { 'роздача': 3, opensource: 2, ai: 1, steam: 1, 'ші': 1 });
  assert.deepEqual(groups.find((g) => g.tag === 'роздача')!.variants, [{ tag: 'роздача', count: 2 }, { tag: 'роздачі', count: 1 }]);
});

test('T8 proposal: names by majority; hashtags only in vocabulary mode; nothing proposed without data', () => {
  const posts = [
    { text: 'Каже CEO Microsoft AI Mustafa Suleyman про чипи й дата-центри компанії.', hashtags: ['ai', 'роздача'] },
    { text: 'Так вважає CEO Cerebras Ендрю Фелдман про асистентів удома.', hashtags: ['роздачі', 'ai'] },
    { text: 'Тоні Фаделл і Стів Джобс про гаджети, які ніхто не купив.', hashtags: [] },
  ];
  const off = buildStyleProposal('telegram:@x', posts, { hashtags: 'off' });
  assert.equal(off.names.propose, 'uk_translit');
  assert.deepEqual(off.names.examples.latin, ['Mustafa Suleyman']);
  assert.equal(off.hashtags, null);
  assert.deepEqual(off.propose, { names: 'uk_translit' });
  const vocab = buildStyleProposal('telegram:@x', posts, { hashtags: 'vocabulary', names: 'uk_translit' });
  assert.deepEqual(vocab.propose, { vocabulary: ['ai', 'роздача'] }, 'the names policy is already set');
  assert.deepEqual(buildStyleProposal('telegram:@x', [], { hashtags: 'vocabulary' }).propose, {});
});

test('T8 proposal: reads published posts of 60 days (Telegram slots or platform captions) and never writes', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (/FROM editor_slots/.test(sql)) return { rows: [{ text: 'Пост #роздача', hashtags: ['роздачі'] }, { text: null, hashtags: null }] };
      if (/FROM platform_posts/.test(sql)) return { rows: [{ text: 'Підпис' }] };
      if (/FROM resource_profiles/.test(sql)) return { rows: [{ profile: { topic: 'Новини', format_prefs: { style: { names: 'original' } } } }] };
      if (/FROM editor_channels/.test(sql)) return { rows: [{ brief: '', title: 'Канал', formats: {}, sources: [], hashtags: ['роздача'] }] };
      return { rows: [] };
    },
  };
  const now = new Date('2026-10-15T12:00:00Z');
  assert.deepEqual(await loadProposalPosts(pool as any, 'telegram:@x', now), [{ text: 'Пост #роздача', hashtags: ['роздачі'] }, { text: '', hashtags: [] }]);
  assert.equal(calls[0].params[0], '@x');
  assert.equal((calls[0].params[2] as Date).toISOString(), '2026-08-16T12:00:00.000Z');
  assert.deepEqual(await loadProposalPosts(pool as any, 'instagram:1', now), [{ text: 'Підпис', hashtags: [] }]);
  assert.ok(calls.every((c) => /^\s*SELECT/.test(c.sql)), 'read-only');
  const view = await resourceStyleOf(pool as any, 'telegram:@x');
  assert.deepEqual(view.stored, { names: 'original' });
  assert.equal(view.kind, 'news');
  assert.equal(view.effective.hashtags, 'vocabulary', 'a news card with a vocabulary keeps it');
  assert.deepEqual(view.defaulted, ['address', 'glossary', 'hashtags', 'content_kind']);
  assert.deepEqual(view.vocabulary, ['роздача']);
});

test('T8 proposal API: a resource ref is required; the port answers', async () => {
  const ops = new EditorOpsService({
    styleProposal: async (ref: string) => ({ ref }) as any,
  } as any);
  await assert.rejects(ops.styleProposal(''), /Bad Request/);
  await assert.rejects(ops.styleProposal('not a ref'), /Bad Request/);
  assert.deepEqual(await ops.styleProposal('telegram:@x'), { ref: 'telegram:@x' });
  await assert.rejects(new EditorOpsService({} as any).styleProposal('telegram:@x'), /Service Unavailable|unavailable/i);
});
