import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMeta, LINK_IN_BIO, POLL_PROMPT } from './render-meta';
import { makeCard, makeSpec } from './testing/fixtures';

const card = makeCard({ footer: 'Підписуйтесь: @chan' });

test('photo: plain caption per platform, links by platform rules, hashtags appended, single image', () => {
  const spec = makeSpec({ body: [{ type: 'lead', text: 'Телескоп **Вебб**' }, { type: 'p', text: 'Деталі в [NASA](https://nasa.gov/x) & <ESA>.' }] });
  const r = renderMeta(spec, card, {}, { telegramLink: 'https://t.me/chan/5' });
  assert.deepEqual(Object.keys(r.posts).sort(), ['facebook', 'instagram', 'threads', 'tiktok']);
  assert.equal(r.posts.facebook!.caption,
    'Телескоп Вебб\n\nДеталі в NASA (https://nasa.gov/x) & <ESA>.\n\nДжерело: https://nasa.gov/ring\nПідписуйтесь: @chan\n↗ https://t.me/chan/5\n#космос');
  assert.equal(r.posts.instagram!.caption, `Телескоп Вебб\n\nДеталі в NASA & <ESA>.\n\n${LINK_IN_BIO}\nПідписуйтесь: @chan\n#космос`);
  assert.deepEqual(r.posts.instagram!.imageUrls, ['https://images.nasa.gov/ring.jpg']);
  assert.equal(r.posts.instagram!.carousel, false);
  assert.doesNotMatch(r.posts.threads!.caption, /<b>|\*\*/);
});

test('no source → no "link in bio" line on Instagram', () => {
  const r = renderMeta(makeSpec({ origin: 'original', source: undefined }), makeCard());
  assert.doesNotMatch(r.posts.instagram!.caption, new RegExp(LINK_IN_BIO));
});

test('text without image: Facebook/Threads text-only, Instagram/TikTok skipped', () => {
  const r = renderMeta(makeSpec({ format: 'text', media: [] }), card);
  assert.deepEqual(r.posts.facebook!.imageUrls, []);
  assert.ok(r.posts.threads);
  assert.deepEqual(r.skipped, { instagram: 'needs_image', tiktok: 'needs_image' });
});

test('album → carousel of all images; carousel → prepared slides, skipped when not prepared', () => {
  const album = renderMeta(makeSpec({ format: 'album', media: [{ url: 'https://a.example/1.jpg' }, { url: 'https://a.example/2.jpg' }] }), card);
  assert.deepEqual(album.posts.instagram, { ...album.posts.instagram!, imageUrls: ['https://a.example/1.jpg', 'https://a.example/2.jpg'], carousel: true });

  const spec = makeSpec({ format: 'carousel', media: [], slides: [{ title: 'А', text: 'а' }, { title: 'Б', text: 'б' }] });
  const ok = renderMeta(spec, card, { slideUrls: ['https://cdn/1.png', 'https://cdn/2.png'] });
  assert.deepEqual(ok.posts.tiktok!.imageUrls, ['https://cdn/1.png', 'https://cdn/2.png']);
  assert.equal(ok.posts.facebook!.carousel, true);
  const none = renderMeta(spec, card);
  assert.deepEqual(Object.keys(none.posts), []);
  assert.equal(none.skipped.instagram, 'carousel_not_prepared');
});

test('poll/quiz: question + options + prompt on Facebook/Threads, skipped on Instagram/TikTok, answer not revealed', () => {
  const spec = makeSpec({
    format: 'quiz', media: [], body: [{ type: 'lead', text: 'Перевір себе' }], hashtags: ['космос'],
    poll: { question: 'Яка планета **найбільша**?', options: ['Марс', 'Юпітер'], correct_index: 1, explanation: 'Юпітер — гігант' },
  });
  const r = renderMeta(spec, makeCard());
  assert.equal(r.posts.threads!.caption,
    `Перевір себе\n\nЯка планета найбільша?\n\n• Марс\n• Юпітер\n\n${POLL_PROMPT}\n\nДжерело: https://nasa.gov/ring\n#космос`);
  assert.doesNotMatch(r.posts.facebook!.caption, /гігант/);
  assert.deepEqual(r.posts.facebook!.imageUrls, []);
  assert.deepEqual(r.skipped, { instagram: 'poll_not_supported', tiktok: 'poll_not_supported' });
});

test('longread: teaser + Telegraph link on Facebook/Threads only after preparation; video: text on FB/Threads only', () => {
  const lr = makeSpec({ format: 'longread', media: [], longread: { title: 'Стаття', blocks: [{ type: 'p', text: 'Текст' }] } });
  assert.equal(renderMeta(lr, card).skipped.facebook, 'longread_not_prepared');
  const r = renderMeta(lr, card, { longreadUrl: 'https://telegra.ph/x' });
  assert.match(r.posts.facebook!.caption, /Читати: https:\/\/telegra\.ph\/x/);
  assert.equal(r.skipped.instagram, 'longread_not_supported');

  const v = renderMeta(makeSpec({ format: 'video', media: [{ url: 'https://cdn/v.mp4', kind: 'video' }] }), card);
  assert.deepEqual(v.posts.threads!.imageUrls, []);
  assert.deepEqual(v.skipped, { instagram: 'video_not_supported', tiktok: 'video_not_supported' });
});

test('Threads 500-char limit cuts the body, never the source and hashtags', () => {
  const r = renderMeta(makeSpec({ format: 'text', body: [{ type: 'p', text: 'а'.repeat(900) }] }), card);
  const c = r.posts.threads!.caption;
  assert.equal(c.length, 500);
  assert.match(c, /…\n\nДжерело: https:\/\/nasa\.gov\/ring\nПідписуйтесь: @chan\n#космос$/);
  assert.equal(r.posts.facebook!.caption.length > 900, true);
});
