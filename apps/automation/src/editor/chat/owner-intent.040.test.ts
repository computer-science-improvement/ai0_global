import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAffirmative, ownerChangeIntent, proposedChange } from './owner-intent';
import { hasAgentChangeIntent } from '../agents/mentions';
import { lastAssistantText } from './editor-chat.service';

/** Spec 040 FR-009: intent verbs and short affirmative replies. */

test('new change verbs count; negation still wins; «відмінно» is not «відміни»', () => {
  for (const t of ['перепланируй день', 'переплануй сьогодні', 'скасуй пост на 18:00', 'відміни слот', 'перенеси на вечір', 'пропусти цей слот',
    'перезапусти слот', 'перегенеруй текст', 'cancel the 6 pm post', 'reschedule it', 'skip this one', 'move it to 9', 'regenerate the post']) {
    assert.equal(hasAgentChangeIntent(t), true, t);
  }
  assert.equal(hasAgentChangeIntent('не скасовуй нічого'), false);
  assert.equal(hasAgentChangeIntent("don't cancel it"), false);
  assert.equal(hasAgentChangeIntent('Відмінно, дякую'), false);
});

test('short affirmative replies, in either layout; long or negative ones are not', () => {
  for (const t of ['так', 'Так!', '+', 'ок', 'давай', 'yes', 'Yes, do it', 'nfr', 'так, роби', 'ок, давай, дякую', '👍 так']) assert.equal(isAffirmative(t), true, t);
  for (const t of ['ні', 'не треба', 'no', 'так, але не зараз', 'так, тільки спершу покажи мені план на завтра з темами', 'що це?', '']) assert.equal(isAffirmative(t), false, t);
});

test('a "yes" is intent only after an assistant turn that proposed a change', () => {
  const offer = 'Можу перепланувати сьогоднішній день: прибрати два опитування й додати новину. Зробити?';
  assert.equal(proposedChange(offer), true);
  assert.equal(ownerChangeIntent('так', offer), true);
  assert.equal(ownerChangeIntent('так', 'Сьогодні вийшло 3 пости, усі без помилок.'), false);
  assert.equal(ownerChangeIntent('так', null), false);
  assert.equal(ownerChangeIntent('ні', offer), false);
  assert.equal(lastAssistantText([{ role: 'user', content: 'a' }, { role: 'assistant', content: offer }, { role: 'user', content: 'так' }]), offer);
});
