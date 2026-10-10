import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choiceInput, initialState, markdownLiteToTgHtml, parsePayload, previewMessages, savedCount } from './content-examples';

const RAW = {
  handle: 'nova', resource_ref: 'telegram:@sky',
  examples: [
    { format: 'photo', title: 'Mars', text: 'Mars is **close** tonight.', why: 'one number', render: [{ method: 'sendMessage', text: 'Mars is <b>close</b> tonight.', preview: null, buttons: [] }], notes: [] },
    { format: 'text', title: 'Perihelion', text: 'Perihelion is the closest point.', why: 'a term', render: null, notes: ['two exclamation marks'] },
    { format: 'text', title: 'Eclipse', text: 'Eclipse on 12 August.', why: 'a date' },
  ],
  warnings: [
    { pattern: 'Clickbait', why: 'trust', bad_example: 'YOU WILL NOT BELIEVE' },
    { pattern: 'Forced humour', why: 'humour is off', bad_example: 'Martians hid the water lol', format: 'text' },
  ],
};

test('parsePayload: defensive read of a stored card', () => {
  const p = parsePayload(RAW);
  assert.equal(p.examples.length, 3);
  assert.equal(p.examples[2].render, null);
  assert.deepEqual(p.examples[1].notes, ['two exclamation marks']);
  assert.equal(p.warnings[0].format, 'text');
  assert.deepEqual(parsePayload(null), { handle: '', resource_ref: '', examples: [], warnings: [] });
  assert.deepEqual(parsePayload({ examples: 'x', warnings: [1] }).warnings, [{ pattern: '', why: '', bad_example: '', format: 'text' }]);
});

test('choiceInput: verdicts, only changed edits, notes, kept warnings', () => {
  const p = parsePayload(RAW);
  const s = initialState(p);
  assert.deepEqual(savedCount(s), { good: 3, bad: 2 });
  s.examples[1] = { verdict: 'bad', text: null, note: ' too school-like ' };
  s.examples[2] = { verdict: 'good', text: 'Eclipse on 12 August, visible from Spain.', note: '' };
  s.examples[0] = { verdict: 'good', text: 'Mars is **close** tonight.', note: '' };
  s.keep[0] = false;
  assert.deepEqual(choiceInput(p, s), {
    examples: [
      { index: 0, verdict: 'good' },
      { index: 1, verdict: 'bad', note: 'too school-like' },
      { index: 2, verdict: 'good', text: 'Eclipse on 12 August, visible from Spain.' },
    ],
    warnings: [{ index: 0, keep: false }, { index: 1, keep: true }],
  });
  assert.deepEqual(savedCount(s), { good: 2, bad: 2 });
});

test('previews: the server render as written; an edit becomes a text bubble with the same markup', () => {
  const p = parsePayload(RAW);
  assert.equal(previewMessages(p.examples[0], null), p.examples[0].render);
  assert.equal(previewMessages(p.examples[0], 'Mars is **close** tonight.'), p.examples[0].render, 'unchanged edit');
  const edited = previewMessages(p.examples[0], 'Mars <script> is **very** close.\n\nSee [NASA](https://nasa.gov) and _now_.');
  assert.equal(edited[0].method, 'sendMessage');
  assert.equal((edited[0] as any).text, 'Mars &lt;script&gt; is <b>very</b> close.\n\nSee <a href="https://nasa.gov">NASA</a> and <i>now</i>.');
  assert.equal((previewMessages(p.examples[2], null)[0] as any).text, 'Eclipse on 12 August.', 'no render: built from the text');
  assert.equal(markdownLiteToTgHtml('a & b'), 'a &amp; b');
});
