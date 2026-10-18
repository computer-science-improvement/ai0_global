/**
 * Review 10-18 (@ai0_prompts_dev): owner rule #23 «вимкнути перевірку мови» was stored, but `not_ukrainian` is switched by
 * the card's language, so posts kept failing and the agent said only a code change could help. The rule is now a config
 * conflict whose fix sets the card's language; the lint names where the check comes from.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configConflicts, ENGLISH_CHANNEL_RE, LANGUAGE_CHECK_OFF_RE } from './config-conflicts';
import { ConfigConflictsService } from './config-conflicts.service';
import { lintPost } from '../post/lint-post';
import { makeCard, makeSpec } from '../post/testing/fixtures';

const REF = 'telegram:@ai0_prompts_dev';

test('rules that turn the Ukrainian check off are recognised; others are not', () => {
  for (const t of ['вимкнути перевірку мови', 'Вимкни правило про українську мову', 'без перевірки мови', 'не перевіряй кирилицю', 'disable the language check', 'ignore not_ukrainian']) {
    assert.ok(LANGUAGE_CHECK_OFF_RE.test(t), t);
  }
  for (const t of ['пишемо англійською', 'Posts are in English']) assert.ok(ENGLISH_CHANNEL_RE.test(t), t);
  for (const t of ['Без хештегів', 'перевіряй факти перед публікацією', 'мова жива, без канцеляриту']) {
    assert.ok(!LANGUAGE_CHECK_OFF_RE.test(t) && !ENGLISH_CHANNEL_RE.test(t), t);
  }
});

test('a language rule against a "uk" card is a conflict; "mixed" for a plain off, "en" for an English channel; none once fixed', () => {
  const base = { playbook: null, resources: [{ ref: REF, language: 'uk' }] };
  const [c] = configConflicts({ ...base, rules: [{ id: 23, text: 'вимкнути перевірку мови' }] });
  assert.equal(c.code, 'language_check_rule');
  assert.deepEqual(c.fix, { target: 'card', op: 'language', channelKey: '@ai0_prompts_dev', language: 'mixed' });
  assert.deepEqual(configConflicts({ ...base, rules: [{ id: 24, text: 'Пости пишемо англійською' }] })[0].fix, { target: 'card', op: 'language', channelKey: '@ai0_prompts_dev', language: 'en' });
  assert.deepEqual(configConflicts({ rules: [{ id: 23, text: 'вимкнути перевірку мови' }], playbook: null, resources: [{ ref: REF, language: 'mixed' }] }), []);
  assert.deepEqual(configConflicts({ ...base, rules: [{ id: 1, text: 'Без хештегів' }] }), []);
});

test('the resolver card sets the card language, and the lint no longer fails', async () => {
  let language = 'uk';
  const svc = new ConfigConflictsService({
    memory: { listActive: async () => [{ id: 23, kind: 'rule', text: 'вимкнути перевірку мови', evidence: null, createdBy: 'owner', createdAt: new Date() }] } as any,
    network: { groupOfChannel: async () => null, groupResources: async () => [], activePlaybook: async () => null, applyOwnerPatch: async () => ({ noop: true }) } as any,
    channels: {
      get: async () => ({ style: null, slang: false, pollsPerWeek: null, hashtags: [], hashtagMin: 0, language }),
      setHashtagMin: async () => false,
      setLanguage: async (_k: string, l: string) => { const changed = l !== language; language = l; return changed; },
    } as any,
    profiles: { get: async () => null } as any,
  });
  const orch: any = { id: 'o', kind: 'orchestrator', scope: 'resource', scopeId: REF, parentId: null };
  const r = await svc.apply(orch);
  assert.deepEqual(r.applied, ['language_check_rule']);
  assert.equal(language, 'mixed');
  assert.deepEqual(r.remaining, []);

  const english = makeSpec({ title: 'Prompt of the day', body: [{ type: 'lead', text: 'Prompt of the day: write a haiku about the sea, step by step.' }, { type: 'p', text: 'Paste it into any model and compare the answers you get back.' }] });
  const failed = lintPost(english, makeCard({ language: 'uk' })).errors.find((e) => e.code === 'not_ukrainian');
  assert.match(failed!.message, /мова в картці каналу \(language = uk\); правило в памʼяті її не вимикає/);
  assert.ok(!lintPost(english, makeCard({ language: 'mixed' })).errors.some((e) => e.code === 'not_ukrainian'));
});

test('a verbatim prompt in a code block does not count against the Ukrainian check; the same prompt as prose does', () => {
  const PROMPT = 'a woman walking through a lush green field,vogue fashion photo,brown tuffle coat,beautiful swedish forest view,mages,film still from dune 2020 --v 5.2 --ar 3:4';
  const lead = { type: 'lead', text: 'Промпт дня: жінка в полі, модне фото' };
  const meta = { type: 'p', text: '🤖 Модель: Midjourney 5.2 · 📐 Розмір: 3:4' };
  const asCode = makeSpec({ title: 'Midjourney 5.2: жінка в полі', body: [lead, { type: 'code', text: PROMPT }, meta] });
  const asProse = makeSpec({ title: 'Midjourney 5.2: жінка в полі', body: [lead, { type: 'p', text: PROMPT }, meta] });
  const uk = makeCard({ language: 'uk' });
  assert.ok(!lintPost(asCode, uk).errors.some((e) => e.code === 'not_ukrainian'));
  const err = lintPost(asProse, uk).errors.find((e) => e.code === 'not_ukrainian');
  assert.match(err!.message, /у блок code: він не рахується/);
});
