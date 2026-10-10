import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audienceSummary, formatValue, toForm, toPrefs, voiceSummary } from './format-prefs';

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

test('format prefs: humour and slang (spec 034) — off by default, owner turns them on', () => {
  assert.deepEqual(toPrefs(toForm({ humor: 'light', slang: true })), { humor: 'light', slang: true });
  assert.equal(toForm({}).humor, '');
  assert.equal(toForm({}).slang, '');
  assert.deepEqual(toPrefs(toForm({ humor: 'none', slang: false })), {}, 'explicit off is the same as unset');
  assert.equal(formatValue('humor', 'light'), 'light, allowed by you');
  assert.equal(formatValue('humor', 'none'), 'off');
  assert.equal(formatValue('slang', true), 'allowed by you');
  assert.equal(formatValue('slang', false), 'off');
  assert.equal(voiceSummary({}), 'No humour · no slang');
  assert.equal(voiceSummary({ humor: 'light', slang: true }), 'Light humour · slang allowed');
});

test('format prefs: audience caps (spec 034 FR-005) — round trip, labels and the summary line', () => {
  assert.deepEqual(toPrefs(toForm({ content_kind: 'news', polls_per_week: 0, questions_to_readers_per_day: 0 })),
    { content_kind: 'news', polls_per_week: 0, questions_to_readers_per_day: 0 });
  assert.deepEqual(toPrefs(toForm({})), {}, 'empty = the defaults');
  assert.equal(toForm({ polls_per_week: 2 }).pollsPerWeek, '2');
  assert.equal(formatValue('content_kind', 'quiz'), 'Quiz');
  assert.equal(formatValue('polls_per_week', 1), 'up to 1');
  assert.equal(audienceSummary({}), 'polls: up to 1 a week (default) · reader questions: up to 1 per post (default)');
  assert.equal(audienceSummary({}, { kind: 'news', kindInferred: true, pollsPerWeek: 1, questionsPerDay: 0 }),
    'News (from the topic) · polls: up to 1 a week (default) · no reader questions (default)');
  assert.equal(audienceSummary({ content_kind: 'quiz' }), 'Quiz · polls: no limit (default) · reader questions: up to 1 per post (default)');
  assert.equal(audienceSummary({ polls_per_week: 0, questions_to_readers_per_day: 2 }), 'no polls · reader questions: up to 2 per post');
});
