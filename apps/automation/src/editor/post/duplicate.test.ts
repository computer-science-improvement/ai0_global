/**
 * Spec 024 T3: duplicateSpec() is the pure starting draft of a duplicate —
 * same content and media, no soft rules (no hashtag cut, no caption trim).
 * Snapshots per platform pair.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duplicateSpec, mediaCapacity, sourceMediaOf } from './duplicate';
import { makeSpec } from './testing/fixtures';
import { PlatformPostSpecSchema, lintPlatformPost } from '../platform/platform-spec';

const TAGS = ['космос', 'nasa', 'фото', 'вебб', 'туманність', 'астрономія', 'наука'];
const tgPhoto = makeSpec({ hashtags: TAGS.slice(0, 7), cta: { url: 'https://nasa.gov/ring/more', label: 'Більше' } });
const tgCarousel = makeSpec({
  format: 'carousel', media: [], hashtags: ['космос'],
  slides: [{ title: 'Сатурн', text: 'Кільця тоншають.' }, { title: 'Коли', text: 'За 300 млн років.' }],
});
const igCarousel = PlatformPostSpecSchema.parse({
  format: 'ig_carousel', title: 'Кільця Сатурна', caption: '**Кільця тоншають**\n\nГортай, щоб дізнатися чому.', hashtags: ['космос', 'сатурн'],
  slides: [{ title: 'Сатурн', text: 'Кільця втрачають масу.' }, { title: 'Коли?', text: 'За ~300 млн років.' }],
  first_comment: 'Джерело: NASA', source: { url: 'https://nasa.gov/saturn' },
});

test('Telegram photo → Instagram photo: body as caption, every hashtag kept, the CTA becomes the link', () => {
  const d = duplicateSpec({ platform: 'telegram', spec: tgPhoto }, { platform: 'instagram', format: 'ig_photo' }, { ideaId: '00000000-0000-4000-8000-000000000001' });
  assert.deepEqual(d, {
    format: 'ig_photo', title: 'Новий знімок туманності',
    caption: '**Телескоп Вебб показав туманність Кільце**\n\nНа знімку видно оболонки газу, які зоря скинула тисячі років тому.',
    hashtags: TAGS.slice(0, 7), media: [{ url: 'https://images.nasa.gov/ring.jpg', kind: 'image' }],
    link: { url: 'https://nasa.gov/ring/more', label: 'Більше' }, source: { url: 'https://nasa.gov/ring', label: 'NASA' },
    idea_id: '00000000-0000-4000-8000-000000000001',
  });
  // A draft, not the result: 7 hashtags are above Instagram's recommended range — that is for the agent to decide.
  const lint = lintPlatformPost(PlatformPostSpecSchema.parse(d), { platform: 'instagram' });
  assert.ok(lint.warnings.some((w) => w.code === 'hashtags_above_recommended'));
});

test('Telegram carousel → Instagram carousel: held slide URLs are reused; without them the slides are re-rendered', () => {
  const held = duplicateSpec({ platform: 'telegram', spec: tgCarousel }, { platform: 'instagram', format: 'ig_carousel' }, { slideUrls: ['https://cdn/s1.png', 'https://cdn/s2.png'] }) as any;
  assert.deepEqual(held.media, [{ url: 'https://cdn/s1.png', kind: 'image' }, { url: 'https://cdn/s2.png', kind: 'image' }]);
  assert.equal(held.slides, undefined);
  const fresh = duplicateSpec({ platform: 'telegram', spec: tgCarousel }, { platform: 'tiktok', format: 'tt_photo' }) as any;
  assert.deepEqual(fresh.slides, tgCarousel.slides);
  assert.deepEqual(fresh.media, []);
});

test('Telegram longread → Threads text: no media, nothing trimmed', () => {
  const long = makeSpec({ format: 'longread', media: [], body: [], longread: { title: 'Стаття', blocks: [{ type: 'p', text: 'А'.repeat(900) }] } });
  const d = duplicateSpec({ platform: 'telegram', spec: long }, { platform: 'threads', format: 'th_text' }) as any;
  assert.equal(d.caption.length, 900, 'no fixed caption trim in code; the agent shortens to 500');
  assert.deepEqual(d.media, []);
});

test('Instagram carousel → Telegram: a carousel PostSpec with lead, slides and the source', () => {
  const d = duplicateSpec({ platform: 'instagram', spec: igCarousel }, { platform: 'telegram', format: 'carousel' }) as any;
  assert.equal(d.format, 'carousel');
  assert.deepEqual(d.body, [{ type: 'lead', text: 'Кільця тоншають' }, { type: 'p', text: 'Гортай, щоб дізнатися чому.' }]);
  assert.deepEqual(d.slides, igCarousel.slides);
  assert.equal(d.origin, 'external');
  assert.deepEqual(d.source, { url: 'https://nasa.gov/saturn' });
});

test('Instagram carousel → Facebook album / Threads text: first comment only on Instagram, media fit the target', () => {
  const fb = duplicateSpec({ platform: 'instagram', spec: igCarousel }, { platform: 'facebook', format: 'fb_album' }) as any;
  assert.equal(fb.format, 'fb_album');
  assert.equal(fb.first_comment, undefined);
  assert.deepEqual(fb.slides, igCarousel.slides);
  const thr = duplicateSpec({ platform: 'instagram', spec: igCarousel }, { platform: 'threads', format: 'th_text' }) as any;
  assert.equal(thr.slides, undefined);
  assert.deepEqual(thr.media, []);
});

test('Telegram → Telegram (another channel) keeps the spec; native media capacity and real media counts', () => {
  const d = duplicateSpec({ platform: 'telegram', spec: tgPhoto }, { platform: 'telegram', format: 'photo' });
  assert.deepEqual(d, tgPhoto);
  assert.deepEqual(mediaCapacity('instagram', 'ig_carousel'), { kind: 'image', min: 2, max: 10 });
  assert.deepEqual(mediaCapacity('telegram', 'carousel'), { kind: 'slides', min: 2, max: 10 });
  assert.deepEqual(sourceMediaOf({ platform: 'telegram', spec: tgCarousel }), { images: 0, videos: 0, slides: 2 });
});
