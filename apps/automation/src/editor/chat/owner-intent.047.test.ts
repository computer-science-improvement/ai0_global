/** Spec 047 FR-001: requirement phrasing and replies that pick an offered option count as the owner's intent. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasAgentChangeIntent } from '../agents/mentions';
import { offeredOptions, ownerChangeIntent, picksOfferedOption } from './owner-intent';

test('a requirement is a request: «хай буде», «потрібно щоб», «хочу щоб», «дай»; not when negated; «дайджест» is not «дай»', () => {
  for (const t of [
    "хай буде ім'я — Машина",
    'потрібно щоб ці правила завжди виконувались для всіх постів',
    'хочу щоб агент писав коротше',
    'нехай публікує о 9 ранку',
    'дай йому інший емодзі',
    'треба щоб опитування були щопонеділка',
    'let it be Rocket',
    'I want shorter posts',
  ]) assert.equal(hasAgentChangeIntent(t), true, t);
  for (const t of ['не треба нічого міняти', 'не хочу щоб ти щось чіпав', 'що в дайджесті сьогодні?', 'як справи?', 'покажи план']) {
    assert.equal(hasAgentChangeIntent(t), false, t);
  }
});

test('the replay of msg fa69dd75: a name the owner chose after the offer passes the gate', () => {
  const offer = 'Можу перейменувати агента. Варіанти:\n1. Машина\n2. Ракета\n3. Зірка\nЯкий обираєте?';
  assert.deepEqual(offeredOptions(offer), ['машина', 'ракета', 'зірка']);
  assert.equal(ownerChangeIntent("хай буде ім'я — Машина", offer), true);
  assert.equal(ownerChangeIntent('Машина', offer), true);
  assert.equal(ownerChangeIntent('давай 2', offer), true);
  assert.equal(ownerChangeIntent('третій', offer), true);
  assert.equal(ownerChangeIntent('5', offer), false, 'no fifth option');
  assert.equal(ownerChangeIntent('ні, не Машина', offer), false, 'negation wins');
});

test('quoted and bold options; an option is only a pick after an offer of a change', () => {
  const offer = 'Пропоную змінити назву на «Кухня щодня» або **Смачно**. Що оберете?';
  assert.deepEqual(offeredOptions(offer), ['кухня щодня', 'смачно']);
  assert.equal(picksOfferedOption('Кухня щодня', offer), true);
  assert.equal(picksOfferedOption('@ai0 смачно!', offer), true);
  assert.equal(picksOfferedOption('Кухня щодня', 'Ось статистика: «Кухня щодня» має 1200 підписників.'), false, 'no change was offered');
  assert.equal(picksOfferedOption('а розкажи детальніше, чому саме кухня щодня краща за інші варіанти, бо мені здається що це занадто довга назва для каналу', offer), false, 'a long message speaks for itself');
});
