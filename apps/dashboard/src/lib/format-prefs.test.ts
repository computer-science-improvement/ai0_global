import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatValue, toForm, toPrefs } from './format-prefs';

test('format prefs: form round trip drops empty fields (empty = the agent’s judgement)', () => {
  const prefs = {
    tone: 'Friendly', length: { target: 300, max: 600 }, emoji: 'none' as const, hashtags: { count: 3, fixed: ['space'] },
    links: 'bio' as const, preferred_formats: ['ig_carousel'], media: { aspect: '4:5' }, notes: 'Question first',
  };
  assert.deepEqual(toPrefs(toForm(prefs)), prefs);
  assert.deepEqual(toPrefs(toForm({})), {});
  const f = toForm({});
  assert.deepEqual(toPrefs({ ...f, hashCount: '0' }), { hashtags: { count: 0, fixed: [] } });
});

test('format prefs: short English lines', () => {
  assert.equal(formatValue('length', { target: 300, max: 600 }), '~300 chars, max 600');
  assert.equal(formatValue('links', 'first_comment'), 'first comment');
  assert.equal(formatValue('hashtags', { count: 3, style: 'lowercase', fixed: ['space'] }), '3 · lowercase · always #space');
  assert.equal(formatValue('emoji', null), '—');
});

test('format prefs: rich messages (spec 033) round trip and label', () => {
  assert.deepEqual(toPrefs(toForm({ rich: 'prefer' })), { rich: 'prefer' });
  assert.equal(toForm({}).rich, '');
  assert.deepEqual(toPrefs({ ...toForm({ rich: 'never' }), rich: '' }), {});
  assert.equal(formatValue('rich', 'auto'), 'when the post has headings or tables');
  assert.equal(formatValue('rich', 'never'), 'never (plain HTML)');
});
