import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newsWatchBody, newsWatchError, newsWatchForm, newsWatchWhen } from './news-watch';

test('news watch form: defaults, the stored body keeps only what differs, and the summary', () => {
  const f = newsWatchForm(undefined);
  assert.deepEqual(f, { mode: 'auto', every: '2', from: '8', to: '22', max: '3' });
  assert.deepEqual(newsWatchBody(f), {}, 'all defaults → nothing stored');
  assert.deepEqual(newsWatchBody({ ...f, mode: 'off' }), { enabled: false });
  assert.deepEqual(newsWatchBody({ ...f, mode: 'on', every: '1', max: '5' }, { max_age_hours: 4 }), { enabled: true, every_hours: 1, max_per_day: 5, max_age_hours: 4 });
  assert.equal(newsWatchForm({ enabled: false }).mode, 'off');
  assert.equal(newsWatchWhen(undefined), 'every 2 h · 08:00–22:00 · up to 3 added a day');
  assert.equal(newsWatchWhen({ enabled: false }), '');
  assert.equal(newsWatchError({ ...f, from: '22', to: '8' }), 'the start hour must be before the end hour');
  assert.equal(newsWatchError({ ...f, mode: 'off', from: '22', to: '8' }), null);
});
