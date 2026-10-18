/**
 * The card's reader language as a channel setting: the writer, composer, platform writer and critic prompts, the lint
 * script check and the Ukrainian lexicon gate follow `editor_channels.language`; card creation, setup and the profile
 * carry it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelLanguage, criticLanguageLines, normalizeChannelLanguage, readerLanguageRule } from './channel-language';
import { lintPost } from './lint-post';
import { makeCard, makeSpec } from './testing/fixtures';
import { buildComposerSystemPrompt, buildSystemPrompt } from '../roles/prompts';
import { SkillLibrary } from '../skills/skill-library';
import { criticUserPrompt, type CriticRequest } from '../critic/critic.service';
import { mergeCard } from '../api/card-input';
import { languagePatch } from '../setup/setup-apply';
import { configConflicts } from '../rules/config-conflicts';
import { AgentCreator } from '../agents/agent-creator';

const UK_LINE = 'Усі тексти для читачів — українською, живою мовою, без канцеляриту й AI-штампів.';

test('a stored or typed value normalises to a card language; anything else is not one', () => {
  for (const [raw, want] of [['uk', 'uk'], ['UA', 'uk'], ['en-US', 'en'], ['pt_BR', 'pt'], [' Mixed ', 'mixed'], ['ro', 'ro']] as const) {
    assert.equal(normalizeChannelLanguage(raw), want, raw);
  }
  for (const raw of ['', 'zz', 'English', 'klingon', null]) assert.equal(normalizeChannelLanguage(raw), null, String(raw));
  assert.equal(channelLanguage(null), 'uk', 'no card reads as the column default');
  assert.equal(channelLanguage({ language: 'zz' }), 'uk');
});

test('the writer, composer and critic prompts follow the card language; Ukrainian keeps the old line', () => {
  const lib = new SkillLibrary();
  const now = new Date('2026-10-18T09:00:00Z');
  assert.equal(readerLanguageRule('uk'), UK_LINE);
  assert.ok(buildSystemPrompt('executor', makeCard(), [], lib).includes(UK_LINE));

  const en = buildSystemPrompt('executor', makeCard({ language: 'en' }), [], lib);
  assert.ok(!en.includes(UK_LINE));
  assert.match(en, /Мова каналу — англійська \(en\): усі тексти для читачів .* пиши цією мовою/);
  assert.match(buildComposerSystemPrompt({ now, card: makeCard({ language: 'pl' }), hasCard: true, memory: [], skills: lib }), /Мова каналу — польська \(pl\)/);
  assert.ok(buildComposerSystemPrompt({ now, card: null, hasCard: false, memory: [], skills: lib }).includes(UK_LINE), 'no channel yet: Ukrainian');
  assert.match(readerLanguageRule('mixed'), /Дослівний іншомовний текст .* у блоці code/);

  const req = (language?: string): CriticRequest => ({
    channelKey: '@c', slotId: 's', mode: 'live', resourceRef: 'telegram:@c', platform: 'telegram', format: 'text',
    text: 'Post', spec: {}, voice: {}, slopWarnings: [], card: language ? { language } : null,
  });
  assert.doesNotMatch(criticUserPrompt(req()), /Мова поста:/);
  assert.doesNotMatch(criticUserPrompt(req('uk')), /Мова поста:/);
  assert.match(criticUserPrompt(req('en')), /Мова поста: англійська \(en\)\. Оцінюй language за нормами цієї мови/);
  assert.deepEqual(criticLanguageLines('uk'), []);
  assert.match(criticLanguageLines('mixed')[0], /лише за українською прозою/);
});

const ENGLISH = makeSpec({ title: 'Prompt of the day', body: [
  { type: 'lead', text: 'Prompt of the day: write a haiku about the sea, step by step.' },
  { type: 'p', text: 'Paste it into any model and compare the answers you get back.' },
] });
const UKRAINIAN = makeSpec({ title: 'Промпт дня', body: [
  { type: 'lead', text: 'Промпт дня: напиши хайку про море, крок за кроком.' },
  { type: 'p', text: 'Встав його в будь-яку модель і порівняй відповіді, які отримаєш.' },
] });
const codes = (spec: typeof ENGLISH, language: string) => lintPost(spec, makeCard({ language })).errors.map((e) => e.code);

test('the lint checks the script of the card language: uk and Latin-script languages; mixed is not checked', () => {
  assert.ok(codes(ENGLISH, 'uk').includes('not_ukrainian'));
  assert.ok(!codes(ENGLISH, 'en').some((c) => c === 'not_ukrainian' || c === 'wrong_language'));
  const wrong = lintPost(UKRAINIAN, makeCard({ language: 'en' })).errors.find((e) => e.code === 'wrong_language');
  assert.match(wrong!.message, /мовою каналу — англійська \(en\): латиниці \d+% із потрібних 60%/);
  assert.ok(!codes(UKRAINIAN, 'mixed').includes('wrong_language') && !codes(ENGLISH, 'mixed').includes('not_ukrainian'));
  const short = makeSpec({ title: 'Hello', body: [{ type: 'lead', text: 'Привіт усім!' }] });
  assert.ok(!codes(short, 'en').includes('wrong_language'), 'too short to judge');
});

test('the Ukrainian lexicon gate runs for uk and mixed, not for another language', () => {
  const calque = makeSpec({ title: 'Хакатон', body: [
    { type: 'lead', text: 'Команда буде приймати участь у хакатоні наступного тижня.' },
    { type: 'p', text: 'Реєстрація відкрита до пʼятниці, деталі на сайті організаторів.' },
  ] });
  assert.ok(codes(calque, 'uk').includes('language_calque'));
  assert.ok(codes(calque, 'mixed').includes('language_calque'));
  assert.ok(!codes(calque, 'en').includes('language_calque'));
});

test('the card API stores a language code; setup and the profile carry it to the card', () => {
  const ok = mergeCard('@c', null, { language: 'en-US' });
  assert.ok(ok.ok && ok.card.language === 'en');
  const bad = mergeCard('@c', null, { language: 'klingon' });
  assert.ok(!bad.ok && bad.issues[0].path[0] === 'language');

  assert.deepEqual(languagePatch('en', { language: 'uk' }), { language: 'en' });
  assert.deepEqual(languagePatch('uk', { language: 'mixed' }), {}, 'a mixed card stays mixed for Ukrainian posts');
  assert.deepEqual(languagePatch('uk', { language: 'uk' }), {});
  assert.deepEqual(languagePatch('українська', { language: 'en' }), {}, 'not a code: no change');

  const ref = 'telegram:@c';
  const [c] = configConflicts({ rules: [], playbook: null, resources: [{ ref, language: 'en', profile: { language: 'uk' } }] });
  assert.equal(c.code, 'language_profile_card');
  assert.deepEqual(c.fix, { target: 'profile', op: 'language', ref, language: 'en' });
  assert.deepEqual(configConflicts({ rules: [], playbook: null, resources: [{ ref, language: 'mixed', profile: { language: 'uk' } }] }), []);
});

test('the card of a new agent takes the language of its profile', async () => {
  const inserted: Array<{ language: string }> = [];
  const creator = new AgentCreator({
    agents: { findTop: async () => null, handleTaken: async () => false, insert: async (a: any) => ({ id: 'a1', ...a }) } as any,
    registry: { ensureChildren: async () => {} } as any,
    catalog: { list: async () => [{ ref: 'telegram:@en_news', platform: 'telegram', agent: null, groupId: null }] } as any,
    profiles: { setProfile: async () => {} } as any,
    channels: { get: async () => null, insertIfMissing: async (c) => { inserted.push(c); return true; } },
  });
  const r = await creator.create({
    resource_ref: 'telegram:@en_news', name: 'EN News', handle: 'ennews',
    profile: { topic: 'Tech news for developers', language: 'en', audience: { who: 'developers' }, goals: ['growth'] },
  });
  assert.ok(!('error' in r), JSON.stringify(r));
  assert.equal(inserted[0].language, 'en');
});
