import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followUpInput, followUpLabel, followUpsOf, initialSkip, outcomeBadge, outcomesOf } from './follow-ups';

const payload = {
  url: 'https://example.com/list',
  then: [
    { key: 'series', kind: 'series_change', summary: 'Series change for @ai_global: bind to nanobanana', payload: {}, requires: 'main_rows' },
    { key: 'rule', kind: 'owner_rule', summary: 'Owner rule: no PromptHero', payload: {} },
    { key: 'detach:old', kind: 'detach_skill', summary: 'Disable skill "old"', payload: {}, ticked: false },
    { kind: 'detach_skill' },
    'junk',
  ],
};

test('follow-ups come out of the payload in order, malformed items left out', () => {
  const items = followUpsOf(payload);
  assert.deepEqual(items.map((i) => [i.key, i.kind, i.ticked]), [['series', 'series_change', true], ['rule', 'owner_rule', true], ['detach:old', 'detach_skill', false]]);
  assert.deepEqual(followUpsOf({}), []);
  assert.deepEqual(followUpsOf(null), []);
  assert.deepEqual(followUpsOf({ then: 'x' }), []);
});

test('only the items the server marked unticked start in skip', () => {
  assert.deepEqual(initialSkip(followUpsOf(payload)), ['detach:old']);
});

test('the Apply input is an explicit list of the unticked keys; none for a card without follow-ups', () => {
  const items = followUpsOf(payload);
  assert.deepEqual(followUpInput(items, ['detach:old']), { skip_then: ['detach:old'] });
  assert.deepEqual(followUpInput(items, []), { skip_then: [] }, 'ticking everything is still a choice the server must see');
  assert.deepEqual(followUpInput(items, ['rule', 'gone']), { skip_then: ['rule'] }, 'only keys of this card');
  assert.equal(followUpInput([], []), null);
});

test('outcomes come out of the result; a result without them is empty', () => {
  const result = { inserted: 4, then: [{ key: 'series', ok: true, result: { version: 4 } }, { key: 'rule', ok: false, error: 'skipped' }, { key: 'detach:old', ok: false, error: 'stale: changed' }, { ok: true }] };
  assert.deepEqual(outcomesOf(result), [{ key: 'series', ok: true }, { key: 'rule', ok: false, error: 'skipped' }, { key: 'detach:old', ok: false, error: 'stale: changed' }]);
  assert.deepEqual(outcomesOf({ inserted: 4 }), []);
  assert.deepEqual(outcomesOf(null), []);
});

test('an outcome is shown as done, left out, not run or failed with the reason', () => {
  assert.deepEqual(outcomeBadge({ key: 'a', ok: true }), { tone: 'success', text: 'done', detail: null });
  assert.equal(outcomeBadge({ key: 'a', ok: false, error: 'skipped' }).text, 'left unticked');
  assert.equal(outcomeBadge({ key: 'a', ok: false, error: 'not_ticked' }).tone, 'neutral');
  assert.deepEqual(outcomeBadge({ key: 'a', ok: false, error: 'import_empty' }), { tone: 'warning', text: 'not run: the import added nothing', detail: null });
  assert.deepEqual(outcomeBadge({ key: 'a', ok: false, error: 'stale: series changed' }), { tone: 'danger', text: 'failed', detail: 'stale: series changed' });
  assert.equal(outcomeBadge(undefined).text, 'not run');
});

test('kind labels are short English names', () => {
  assert.equal(followUpLabel('series_change'), 'Series');
  assert.equal(followUpLabel('some_new_kind'), 'some new kind');
});
