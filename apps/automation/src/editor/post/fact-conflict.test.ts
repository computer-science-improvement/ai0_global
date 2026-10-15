/** Spec 037 T4: fact_conflict — a price, character or deadline told differently by an earlier post. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factConflicts, factsOfPost } from './fact-conflict';
import type { AuditPost } from './integrity/types';

const post = (id: string, publishedAt: string, text: string): AuditPost => ({
  id, channel: 'birzha', publishedAt, timezone: 'Europe/Kyiv', text, links: [], buttons: [], hashtags: [], media: null,
});

const RDR_0810 = post('a', '2026-10-08T11:13:57Z', 'Steam знизив ціни.\n\nSkyrim Special Edition — 64 грн замість 649, знижка 90%.\n\n'
  + 'Red Dead Redemption 2 — 539 грн замість 1799, знижка 70%. У Steam «Надзвичайно позитивні» відгуки.');
const RDR_0910 = post('b', '2026-10-09T15:01:07Z', 'Steam зібрав чотири великі знижки.\n\n• Red Dead Redemption 2: 649 грн замість 2599 грн (−75%)\n'
  + '• Terraria: 112 грн замість 225 грн (−50%), пропозиція діє до 15 жовтня');
const OOS_0910 = post('c', '2026-10-09T09:01:25Z', 'Epic Games Store роздає Out of Sight — пригодницьку гру від студії Team11. Ви граєте за сліпого хлопчика, який досліджує темний маєток.\n\n'
  + 'Роздача триває до 15 жовтня.');
const OOS_1010 = post('d', '2026-10-10T09:01:19Z', 'Epic роздає дві гри до 15 жовтня\n\nOut of Sight, хорор-квест від Team11: граєте за сліпу дівчинку Софі, яка бачить світ очима ведмедика.\n\n'
  + 'TerraScape, cozy-градобудівник.');

test('facts: a price with its subject and discount, a character, a deadline', () => {
  const f = factsOfPost(RDR_0910);
  assert.deepEqual(f.filter((x) => x.kind === 'price').map((x) => [[...x.subject], x.value]),
    [[['name:red dead redemption'], '649/2599/75'], [['name:terraria'], '112/225/50']]);
  const c = factsOfPost(OOS_1010).find((x) => x.kind === 'character')!;
  assert.deepEqual([c.value, c.text], ['дівчин|Софі', 'сліпу дівчинку Софі']);
});

test('RDR2: 539 of 1799 (08.10) vs 649 of 2599 (09.10) → fact_conflict with both values and the date', () => {
  const f = factConflicts(RDR_0910, [RDR_0810]);
  assert.equal(f.length, 1);
  assert.deepEqual([f[0].code, f[0].level], ['fact_conflict', 'warning']);
  assert.match(f[0].message, /649 грн замість 2599 грн \(−75%\)/);
  assert.match(f[0].message, /539 грн замість 1799 \(−70%\)/);
  assert.match(f[0].message, /08\.10\.2026 14:13/);
  assert.match(f[0].message, /скажи це прямо/);
});

test('Out of Sight: a blind boy vs a blind girl Sophie → fact_conflict; the same deadline is no conflict', () => {
  const f = factConflicts(OOS_1010, [OOS_0910]);
  assert.equal(f.length, 1);
  assert.match(f[0].message, /^персонаж/);
  assert.match(f[0].message, /сліпу дівчинку Софі.*сліпого хлопчика/);
});

test('no conflict: the same price, another game, an older post out of the window, a later post', () => {
  const same = post('e', '2026-10-08T12:00:00Z', 'Red Dead Redemption 2 — 539 грн замість 1799.');
  assert.deepEqual(factConflicts(same, [RDR_0810]), []);
  const other = post('f', '2026-10-09T12:00:00Z', 'Cyberpunk 2077 — 419 грн замість 1399, знижка 70%.');
  assert.deepEqual(factConflicts(other, [RDR_0810]), []);
  const old = { ...RDR_0810, publishedAt: '2026-09-20T10:00:00Z' };
  assert.deepEqual(factConflicts(RDR_0910, [old]), [], 'older than 14 days');
  assert.deepEqual(factConflicts(RDR_0810, [RDR_0910]), [], 'only earlier posts count');
});

test('deadline: the same giveaway with another end date → fact_conflict', () => {
  const a = post('g', '2026-10-09T09:00:00Z', 'Epic роздає Out of Sight до 15 жовтня.');
  const b = post('h', '2026-10-10T09:00:00Z', 'Out of Sight ще можна забрати до 16 жовтня.');
  const f = factConflicts(b, [a]);
  assert.equal(f.length, 1);
  assert.match(f[0].message, /^дедлайн.*до 16 жовтня.*до 15 жовтня/);
});
