import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasPublishIntent, mentionedChannels, parseKyivTime } from './intent';

test('explicit publish/schedule requests are recognised', () => {
  for (const m of [
    'Опублікуй це', 'ок, публікуй', 'запости в канал', 'можна опублікувати зараз', 'Заплануй на завтра 19:00',
    'треба запланувати на понеділок', 'постав на 18:00', 'відклади на вечір', 'publish it', 'Schedule for 9am', 'post it now',
    'Зроби пост про Webb для @eval_chat і заплануй на завтра на 19:00',
  ]) assert.equal(hasPublishIntent(m), true, m);
});

test('drafting, editing and negated requests are not a publish request', () => {
  for (const m of [
    'Підготуй пост про Webb', 'зроби коротше', 'додай опитування', 'інша картинка', 'покажи чернетку',
    'не публікуй поки', 'Не опублікуй без мене', 'не плануй', 'а що з публікацією?', 'публікація вчора була слабка',
  ]) assert.equal(hasPublishIntent(m), false, m);
});

test('parseKyivTime: wall-clock in Kyiv, ISO with offset, invalid input', () => {
  // 2026-10-02 is EEST (UTC+3); 2026-12-01 is EET (UTC+2)
  assert.equal(parseKyivTime('2026-10-02 19:00')!.toISOString(), '2026-10-02T16:00:00.000Z');
  assert.equal(parseKyivTime('2026-12-01T09:30')!.toISOString(), '2026-12-01T07:30:00.000Z');
  assert.equal(parseKyivTime('2026-10-02T19:00:00+03:00')!.toISOString(), '2026-10-02T16:00:00.000Z');
  assert.equal(parseKyivTime('2026-10-02T16:00:00Z')!.toISOString(), '2026-10-02T16:00:00.000Z');
  for (const bad of ['завтра о 19', '2026-10-02 25:00', '2026-13-02 10:00', '19:00', '']) assert.equal(parseKyivTime(bad), null, bad);
});

test('mentionedChannels: latest mention first, deduplicated', () => {
  assert.deepEqual(mentionedChannels('для @space_ua, ні — краще @ai0_global, так, @ai0_global'), ['@ai0_global', '@space_ua']);
  assert.deepEqual(mentionedChannels('без каналу'), []);
});
