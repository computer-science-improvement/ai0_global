/** Spec 047 FR-004: rule lint at write time and on the agent page; a list of points is one rule in the owner's words. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentChatTools, ruleToStore } from './agent-chat-tools';
import { contentWords, lintOwnerRule, multiPointRule, ownerListPoints } from './rule-lint';
import { ownerRulesSection } from '../rules/owner-rules-prompt';

const codes = async (t: string, c = {}) => (await lintOwnerRule(t, c)).map((x) => x.code);

test('review-1 junk is caught: #15 pointer-only, #10 a request, #14 an unknown skill; real short rules pass', async () => {
  assert.deepEqual(await codes('Ці правила завжди виконуються для всіх постів'), ['pointer_only']);
  assert.deepEqual(await codes('These rules always apply to all posts'), ['pointer_only']);
  assert.deepEqual(await codes('запамʼятай це на майбутнє'), ['meta_request']);
  assert.deepEqual(await codes('запамʼятай'), ['too_vague', 'meta_request']);
  assert.deepEqual(await codes('Перед кожним постом дивись скіл poster-bank', { skillExists: async (n: string) => n !== 'poster-bank' }), ['unknown_skill']);
  assert.deepEqual(await codes('Анонси робить @nova_dev, а не @ghost', { handles: ['nova_dev', 'loko_games'] }), ['unknown_agent']);
  for (const ok of ['Без хештегів', 'Без мемів по понеділках', 'Щодня публікувати рекламу казино', 'Ці дні — без опитувань: субота й неділя, бо охоплення падає']) {
    assert.deepEqual(await codes(ok), [], ok);
  }
  assert.deepEqual(contentWords('Ці правила завжди виконуються для всіх постів'), []);
});

const OWNER_LIST = [
  'потрібно щоб ці правила завжди виконувались для всіх постів:',
  '1. Без хештегів',
  '2. Емодзі максимум два на пост',
  '3. Заголовок жирним',
  '4. Джерело в кінці посилання',
  '5. Не більше 900 символів',
  '6. Без слова «неймовірно»',
  '7. Питання до аудиторії в кінці',
  '8. Ніяких опитувань у вихідні',
].join('\n');

test('the lost 8-point list: a pointer rule takes the points from the owner\'s message, one rule, his words', async () => {
  assert.equal(ownerListPoints(OWNER_LIST).length, 8);
  const r = await ruleToStore({ text: 'Ці правила завжди виконуються для всіх постів' }, OWNER_LIST, (t) => lintOwnerRule(t));
  assert.equal(r.fromOwnerList, true);
  assert.deepEqual(r.issues, []);
  assert.equal(r.text.split('\n').length, 8);
  assert.equal(r.text.split('\n')[0], '1. Без хештегів');
  assert.equal(r.text.split('\n')[7], '8. Ніяких опитувань у вихідні');

  const withPoints = await ruleToStore({ text: 'Оформлення постів', points: ['Без хештегів', 'Заголовок жирним'] }, OWNER_LIST, (t) => lintOwnerRule(t));
  assert.equal(withPoints.text, 'Оформлення постів:\n1. Без хештегів\n2. Заголовок жирним');
  assert.equal(multiPointRule(['1. a b c', 'd e f']), '1. a b c\n2. d e f');
  assert.deepEqual(ownerListPoints('просто текст\n- один пункт'), [], 'one point is not a list');
});

test('add_owner_rule: a lint failure stores nothing; the owner list is stored as one rule; the writer sees it indented', async () => {
  const adds: any[] = [];
  const tools = Object.fromEntries(buildAgentChatTools({
    pool: { query: async () => ({ rows: [] }) } as any,
    memory: { add: async (...a: any[]) => { adds.push(a); return 77; } },
    skills: { findShared: async () => null } as any,
    actions: { propose: async () => { throw new Error('no card expected'); } } as any,
    handles: async () => ['nova_dev'],
  }).map((t) => [t.name, t]));
  const ctx = (ownerText: string): any => ({ runId: 'r', role: 'composer', channelKey: '@nova', extras: { chat: { chatId: 'c1', channelKey: '@nova' }, agentIntent: true, ownerText, ownerRecent: [ownerText] } });

  const bad: any = await tools.add_owner_rule.execute({ text: 'Ці правила завжди виконуються для всіх постів', kind: 'rule' } as any, ctx('ці правила завжди виконуються для всіх постів'));
  assert.equal(bad.error, 'rule_lint_failed');
  assert.match(bad.details, /^pointer_only/);
  assert.equal(adds.length, 0);

  const good: any = await tools.add_owner_rule.execute({ text: 'Ці правила завжди виконуються для всіх постів', kind: 'rule' } as any, ctx(OWNER_LIST));
  assert.equal(good.ok, true);
  assert.equal(adds.length, 1);
  assert.match(adds[0][2], /^1\. Без хештегів\n2\. Емодзі максимум два на пост/);
  assert.match(ownerRulesSection([{ id: 77, text: adds[0][2] }]).at(-1)!, /^- #77 1\. Без хештегів\n {2}2\. Емодзі/);
});
