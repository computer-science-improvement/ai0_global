import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JARGON_BUDGET, jargonOf, jargonOverLevel } from './jargon';
import { jargonCheck } from '../integrity/checks/variety';
import type { AuditPost } from '../integrity/types';

const fixture = JSON.parse(readFileSync(join(__dirname, '..', 'testing', 'channel-logs-2026-10.json'), 'utf8')) as { posts: AuditPost[] };
const post = (id: string) => fixture.posts.find((p) => p.id === id)!;

test('T9 jargon: the explanation heuristic — parenthesis, dash / colon at the start, «тобто» / «— це», a «Це …» next sentence', () => {
  // 1. A parenthesis gloss of two words or more right after the term; a one-word label is not one.
  assert.deepEqual(jargonOf('Модель на архітектурі MoE (mixture of experts) вийшла.').unexplained, []);
  assert.deepEqual(jargonOf('На MTEB (Code) модель обігнала попередницю.').unexplained, ['MTEB']);
  // …or the term is the gloss of a plain word before it.
  assert.deepEqual(jargonOf('Підрядні агенти (subagents) стають дешевими.').unexplained, []);
  // 2. A dash or colon gloss when the term opens its sentence, line or bullet; a mid-sentence dash is punctuation.
  assert.deepEqual(jargonOf('MCP — USB-порт для ШІ. Підключіть перший сервер.').unexplained, []);
  assert.deepEqual(jargonOf('• RAG: ШІ перед відповіддю шукає факти у ваших документах.').unexplained, []);
  assert.deepEqual(jargonOf('Плюс знижка 50% на batch — довгі сесії дешевшають.').unexplained, ['batch']);
  // 3. The rest of the same sentence explains it.
  assert.deepEqual(jargonOf('Модель має 7 млрд параметрів, тобто внутрішніх налаштувань, які вона вивчила.').unexplained, []);
  assert.deepEqual(jargonOf('Інференс — це етап, коли навчена модель відповідає на запити.').unexplained, []);
  // 4. The next sentence opens with «Це …» and has no figures; «Це на 90% дешевше» or «Це не …» explain nothing.
  assert.deepEqual(jargonOf('Команда YNAB випустила MCP-сервер. Це місток, через який асистент бачить бюджет.').unexplained, []);
  assert.deepEqual(jargonOf('Ціна — $0.10 за мільйон токенів. Це на 90% дешевше.').unexplained, ['токени']);
  assert.deepEqual(jargonOf('Вона дешевша за LLM. Це не заміна моделі.').unexplained, ['LLM']);
  // Any explained occurrence explains the term; distinct terms count once, in order of first use.
  assert.deepEqual(jargonOf('Через API. Через API ще раз. RAG працює. RAG — це пошук у документах перед відповіддю.'), { unexplained: ['API'], explained: ['RAG'] });
  // Abbreviations are case-sensitive (a URL path or #api is not the term).
  assert.deepEqual(jargonOf('Деталі: example.com/api і #llm').unexplained, []);
});

test('T9 jargon: the level budget — beginner 2, general 5, expert none; without a level the check is silent', () => {
  assert.deepEqual(JARGON_BUDGET, { beginner: 2, general: 5, expert: Infinity });
  const three = 'Модель має 49 млрд параметрів, працює через API і рахує кожен токен.';
  assert.deepEqual(jargonOverLevel(three, 'beginner')?.terms, ['параметри', 'API', 'токени']);
  assert.equal(jargonOverLevel(three, 'general'), null);
  assert.equal(jargonOverLevel(three, 'expert'), null);
  assert.equal(jargonOverLevel(three, undefined), null);
});

test('T9 jargon: EmbeddingGemma (07.10) → jargon_over_level for beginner; none for an expert resource or without a level', () => {
  const p = post('ai-tekhnolohii:1024');
  const beginner = jargonCheck.run(p, { previous: [], card: { style: { audience: { level: 'beginner' } } } });
  assert.equal(beginner.length, 1);
  assert.equal(beginner[0].code, 'jargon_over_level');
  assert.equal(beginner[0].level, 'warning');
  assert.match(beginner[0].excerpt!, /embedding.*MTEB.*RAG/);
  assert.match(beginner[0].message, /для аудиторії «початківці» \(можна 2\)/);
  assert.deepEqual(jargonCheck.run(p, { previous: [], card: { style: { audience: { level: 'expert' } } } }), []);
  assert.deepEqual(jargonCheck.run(p, { previous: [] }), []);
  // The beginner explainers of the same channel stay within the budget (glossary, MCP explainer, prompts).
  for (const id of ['ai-tekhnolohii:1035', 'ai-tekhnolohii:1046', 'ai-tekhnolohii:1040', 'ai-tekhnolohii:1032']) {
    assert.deepEqual(jargonCheck.run(post(id), { previous: [], card: { style: { audience: { level: 'beginner' } } } }), [], id);
  }
});
