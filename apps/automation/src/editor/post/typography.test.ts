/** Spec 037 T6: the typography normaliser — rules, protected spans, idempotence, the PostSpec path. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dropDuplicateAttribution, normalizePostSpec, normalizeTypography } from './typography';
import { AgentPostSpecSchema } from './post-spec';
import { AgentPlatformPostSpecSchema } from '../platform/platform-spec';
import { makeSpec } from './testing/fixtures';

const n = normalizeTypography;

test('apostrophe between Cyrillic letters → ʼ (U+02BC)', () => {
  assert.equal(n("Нова функція з'явилась, а б’ються за неї всі"), 'Нова функція зʼявилась, а бʼються за неї всі');
  assert.equal(n('вже зʼявиться'), 'вже зʼявиться');
  assert.equal(n("слово 'в лапках' лишається"), "слово 'в лапках' лишається", 'quote marks next to a space are not apostrophes');
});

test('straight double quotes in Ukrainian text → «»', () => {
  assert.equal(n('Модель "Le Chonk" вийшла, а "відкриті ваги" — ні.'), 'Модель «Le Chonk» вийшла, а «відкриті ваги» — ні.');
  assert.equal(n('"Привіт", — сказав він'), '«Привіт», — сказав він');
  assert.equal(n('екран 6,1" у новинці'), 'екран 6,1" у новинці', 'a lone inch mark is not a pair');
});

test('runs of spaces inside a line collapse; line breaks stay', () => {
  assert.equal(n('Ціна  впала   на 10%.\n\nДругий  абзац'), 'Ціна впала на 10%.\n\nДругий абзац');
});

test('Latin look-alikes inside an otherwise Cyrillic word become Cyrillic; real mixes and Latin words stay', () => {
  assert.equal(n('Це пpивіт із Kиєва'), 'Це привіт із Києва');
  assert.equal(n('корпорація Меркoff'), 'корпорація Меркoff', 'f has no Cyrillic twin: lint reports it');
  assert.equal(n('Apple, OpenAI, iPhone-ом і cool'), 'Apple, OpenAI, iPhone-ом і cool');
});

test('protected: URLs, link targets, inline code, hashtags, @mentions, e-mails; Latin-only text untouched', () => {
  const s = 'Див. [статтю "тут"](https://example.com/a\'b"c) і https://ex.com/з\'явилось та `x  "y"` #з\'явилось @ai_ua mail@пошта.com';
  assert.equal(n(s), 'Див. [статтю «тут»](https://example.com/a\'b"c) і https://ex.com/з\'явилось та `x  "y"` #з\'явилось @ai_ua mail@пошта.com');
  const latin = 'He said "it\'s  fine" — don\'t  worry';
  assert.equal(n(latin), latin, 'no Cyrillic → nothing to normalise');
});

test('idempotent: twice = once, over the rules and over all 63 golden-set posts', () => {
  const samples = [
    "з'явилось \"нове\"  слово пpивіт", 'Модель "Le Chonk" і `code  "x"` https://a.b/c\'d #тег',
    ...(JSON.parse(readFileSync(join(__dirname, 'testing', 'channel-logs-2026-10.json'), 'utf8')).posts as Array<{ text: string }>).map((p) => p.text),
  ];
  for (const s of samples) assert.equal(n(n(s)), n(s));
});

test('normalizePostSpec: every reader-visible string, never code / math / hashtags / URLs', () => {
  const spec = makeSpec({
    format: 'text', media: [],
    body: [
      { type: 'lead', text: "Вебб з'явився \"знову\"" },
      { type: 'list', items: ["пункт з'їзду"] },
      { type: 'code', text: "print('з'явилось')  # \"x\"" },
      { type: 'math', expression: "f'(x)" },
      { type: 'details', title: "Деталі  з'їзду", body: [{ type: 'p', text: 'пpивіт' }] },
    ],
    hashtags: ["з'явилось"],
    buttons: [[{ text: "Сайт з'їзду", url: "https://ex.com/a'b" }]],
  });
  const out = normalizePostSpec(spec);
  assert.deepEqual(out.body[0], { type: 'lead', text: 'Вебб зʼявився «знову»' });
  assert.deepEqual(out.body[1], { type: 'list', items: ['пункт зʼїзду'] });
  assert.deepEqual(out.body[2], spec.body[2], 'code block untouched');
  assert.deepEqual(out.body[3], spec.body[3], 'math untouched');
  assert.deepEqual(out.body[4], { type: 'details', title: 'Деталі зʼїзду', body: [{ type: 'p', text: 'привіт' }] });
  assert.deepEqual(out.hashtags, ["з'явилось"], 'hashtags untouched (lint judges them)');
  assert.deepEqual(out.buttons, [[{ text: 'Сайт зʼїзду', url: "https://ex.com/a'b" }]]);
  assert.deepEqual(normalizePostSpec(out), out, 'idempotent on a spec');
});

test('duplicate attribution: a closing «Джерело: X» naming the rendered source is dropped', () => {
  const source = { url: 'https://techcrunch.com/2026/10/08/openai/', label: 'TechCrunch' };
  const base = [{ type: 'lead', text: 'OpenAI повідомила інвесторам про виторг.' }, { type: 'p', text: 'Цифра походила від інвесторів.' }];
  // The whole last block.
  const whole = makeSpec({ format: 'text', media: [], source, body: [...base, { type: 'p', text: 'Джерело: Financial Times через TechCrunch' }] });
  assert.deepEqual(dropDuplicateAttribution(whole).body, whole.body.slice(0, -1));
  // The last sentence of the last paragraph.
  const tail = makeSpec({ format: 'text', media: [], source, body: [base[0], { type: 'p', text: 'Цифра походила від інвесторів. За даними TechCrunch.' }] });
  assert.deepEqual(dropDuplicateAttribution(tail).body.at(-1), { type: 'p', text: 'Цифра походила від інвесторів.' });
  // Kept: another source, its own link, no rendered source, not the last block.
  const other = makeSpec({ format: 'text', media: [], source, body: [...base, { type: 'p', text: 'Джерело: Reuters' }] });
  assert.equal(dropDuplicateAttribution(other), other);
  const linked = makeSpec({ format: 'text', media: [], source, body: [...base, { type: 'p', text: 'Джерело: [TechCrunch](https://techcrunch.com/other/)' }] });
  assert.equal(dropDuplicateAttribution(linked), linked);
  const noSource = makeSpec({ format: 'text', media: [], source: undefined, origin: 'original', body: [...base, { type: 'p', text: 'Джерело: TechCrunch' }] });
  assert.equal(dropDuplicateAttribution(noSource), noSource);
});

test('agent tool inputs are normalised: AgentPostSpecSchema and AgentPlatformPostSpecSchema', () => {
  const spec = AgentPostSpecSchema.parse({
    format: 'text', title: 'Тест', origin: 'original',
    body: [{ type: 'lead', text: "Нове  \"оновлення\" з'явилось" }, { type: 'p', text: 'Джерело: NASA' }],
    hashtags: ['космос'],
  });
  assert.deepEqual(spec.body, [{ type: 'lead', text: 'Нове «оновлення» зʼявилось' }, { type: 'p', text: 'Джерело: NASA' }], 'no source → attribution kept');
  const p = AgentPlatformPostSpecSchema.parse({
    format: 'th_text', title: 'Тест', caption: "Нове \"оновлення\" з'явилось [тут](https://ex.com/a'b) #з'явилось",
  });
  assert.equal(p.caption, "Нове «оновлення» зʼявилось [тут](https://ex.com/a'b) #з'явилось");
});
