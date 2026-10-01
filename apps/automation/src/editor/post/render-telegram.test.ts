import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeText, renderTelegram } from './render-telegram';
import { makeCard, makeSpec } from './testing/fixtures';

test('photo with short caption → sendPhoto; placement controls caption position', () => {
  const above = renderTelegram(makeSpec({ placement: 'above' }), makeCard());
  const m = above.messages[0] as any;
  assert.equal(m.method, 'sendPhoto');
  assert.equal(m.photo, 'https://images.nasa.gov/ring.jpg');
  assert.equal(m.captionAboveMedia, false);
  const below = renderTelegram(makeSpec({ placement: 'below' }), makeCard()).messages[0] as any;
  assert.equal(below.captionAboveMedia, true);
});

test('composeText: lead bold, inline source, footer, hashtags last', () => {
  const t = composeText(makeSpec(), makeCard({ footer: 'Підписуйся: @chan' }));
  assert.equal(t,
    '<b>Телескоп Вебб показав туманність Кільце</b>\n\n'
    + 'На знімку видно оболонки газу, які зоря скинула тисячі років тому.\n\n'
    + '→ <a href="https://nasa.gov/ring">NASA</a>\n\n'
    + 'Підписуйся: @chan\n#космос');
});

test('link_style footer and button', () => {
  const f = composeText(makeSpec(), makeCard({ linkStyle: 'footer' }));
  assert.match(f, /Джерело: <a href="https:\/\/nasa.gov\/ring">NASA<\/a>\n#космос$/);
  const b = renderTelegram(makeSpec(), makeCard({ linkStyle: 'button' })).messages[0] as any;
  assert.doesNotMatch(b.caption, /nasa.gov/);
  assert.deepEqual(b.buttons, [[{ text: 'Джерело: NASA', url: 'https://nasa.gov/ring' }]]);
});

test('long photo post becomes text with large preview (no truncation)', () => {
  const long = makeSpec({ body: [{ type: 'p', text: 'а'.repeat(1400) }] });
  const m = renderTelegram(long, makeCard()).messages[0] as any;
  assert.equal(m.method, 'sendMessage');
  assert.deepEqual(m.preview, { url: 'https://images.nasa.gov/ring.jpg', showAboveText: true });
});

test('text without media has no preview; cta and buttons become keyboard rows', () => {
  const spec = makeSpec({ format: 'text', media: [], cta: { url: 'https://x.example/buy', label: 'Купити' }, buttons: [[{ text: 'Більше', url: 'https://x.example' }]] });
  const m = renderTelegram(spec, makeCard()).messages[0] as any;
  assert.equal(m.preview, null);
  assert.deepEqual(m.buttons, [[{ text: 'Купити', url: 'https://x.example/buy' }], [{ text: 'Більше', url: 'https://x.example' }]]);
});

test('album → media group with caption', () => {
  const spec = makeSpec({ format: 'album', media: [{ url: 'https://a.example/1.jpg' }, { url: 'https://a.example/2.jpg' }] });
  const r = renderTelegram(spec, makeCard());
  assert.equal(r.messages[0].method, 'sendMediaGroup');
  assert.deepEqual((r.messages[0] as any).photos, ['https://a.example/1.jpg', 'https://a.example/2.jpg']);
});

test('quiz with intro → message then poll; primary is the poll', () => {
  const spec = makeSpec({
    format: 'quiz', media: [],
    body: [{ type: 'lead', text: 'Перевір себе' }],
    poll: { question: 'Яка планета **найбільша**?', options: ['Марс', 'Юпітер'], correct_index: 1, explanation: 'Юпітер — газовий гігант' },
  });
  const r = renderTelegram(spec, makeCard());
  assert.equal(r.messages.length, 2);
  assert.equal(r.primary, 1);
  const poll = r.messages[1] as any;
  assert.equal(poll.question, 'Яка планета найбільша?');
  assert.equal(poll.quiz, true);
  assert.equal(poll.correctIndex, 1);
  assert.match(r.preview, /✅ Юпітер/);
});

test('poll without body → single poll; correctIndex ignored for regular poll', () => {
  const spec = makeSpec({ format: 'poll', media: [], body: [], poll: { question: 'Що краще?', options: ['A', 'B'], correct_index: 0 } });
  const r = renderTelegram(spec, makeCard());
  assert.equal(r.messages.length, 1);
  assert.equal((r.messages[0] as any).correctIndex, null);
});

test('escaping: hostile text, label and hashtag', () => {
  const spec = makeSpec({ body: [{ type: 'p', text: 'x < y & "z"' }], hashtags: ['<b>'], source: { url: 'https://e.example/?a="1"', label: '<i>' } });
  const t = composeText(spec, makeCard());
  assert.match(t, /x &lt; y &amp; "z"/);
  assert.match(t, /href="https:\/\/e.example\/\?a=&quot;1&quot;">&lt;i&gt;<\/a>/);
  assert.match(t, /#&lt;b&gt;/);
});
