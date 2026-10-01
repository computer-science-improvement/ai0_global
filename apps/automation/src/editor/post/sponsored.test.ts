import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AD_LABEL, SponsoredCreativeSchema, creativeFromText, lintSponsored, renderSponsored, sponsoredFooter } from './sponsored';
import { makeCard } from './testing/fixtures';

const creative = (over: Record<string, unknown> = {}) => SponsoredCreativeSchema.parse({
  format: 'text',
  body: [{ type: 'lead', text: 'Курс з програмування для дітей' }, { type: 'p', text: 'Перший урок безкоштовно.' }],
  ...over,
});

function lastLine(s: string): string {
  const lines = s.split('\n');
  return lines[lines.length - 1];
}

test('schema: a PostSpec subset — hashtags, source and library_ref are rejected', () => {
  assert.equal(SponsoredCreativeSchema.safeParse({ body: [{ type: 'p', text: 'x' }], hashtags: ['a'] }).success, false);
  assert.equal(SponsoredCreativeSchema.safeParse({ body: [{ type: 'p', text: 'x' }], source: { url: 'https://a.ua' } }).success, false);
  assert.equal(SponsoredCreativeSchema.safeParse({ body: [{ type: 'p', text: 'x' }], library_ref: 'library://facts/1' }).success, false);
  assert.equal(SponsoredCreativeSchema.safeParse({ format: 'album', body: [{ type: 'p', text: 'x' }] }).success, false);
  assert.equal(SponsoredCreativeSchema.safeParse({ body: [] }).success, false);
  const two = [{ url: 'https://a.ua/1.jpg' }, { url: 'https://a.ua/2.jpg' }];
  assert.equal(SponsoredCreativeSchema.safeParse({ format: 'photo', body: [{ type: 'p', text: 'x' }], media: two }).success, false);
});

test('renderSponsored: the final line is always #реклама, added by code', () => {
  const r = renderSponsored(creative(), makeCard({ footer: 'Підпишись на канал' }), { advertiser: 'ТОВ Приклад' });
  const m = r.messages[0];
  assert.equal(m.method, 'sendMessage');
  if (m.method !== 'sendMessage') return;
  assert.equal(lastLine(m.text), AD_LABEL);
  assert.ok(!m.text.includes('Підпишись на канал'), 'the channel footer is replaced by the ad label');
  assert.match(m.text, /<b>Курс з програмування для дітей<\/b>/);
});

test('renderSponsored: optional "Реклама. Замовник" line comes before #реклама and is escaped', () => {
  const r = renderSponsored(creative(), makeCard(), { advertiser: 'x', sponsorLabel: 'ТОВ <Б&В>' });
  const m = r.messages[0];
  if (m.method !== 'sendMessage') return assert.fail('expected sendMessage');
  const lines = m.text.split('\n');
  assert.equal(lines[lines.length - 1], AD_LABEL);
  assert.equal(lines[lines.length - 2], 'Реклама. Замовник: ТОВ &lt;Б&amp;В&gt;');
});

test('renderSponsored: photo + cta → sendPhoto with caption ending in #реклама and a URL button', () => {
  const c = creative({ format: 'photo', media: [{ url: 'https://cdn.example.com/ad.jpg' }], cta: { url: 'https://shop.example.com', label: 'Купити' } });
  const r = renderSponsored(c, makeCard(), { advertiser: 'Shop' });
  const m = r.messages[0];
  if (m.method !== 'sendPhoto') return assert.fail('expected sendPhoto');
  assert.equal(lastLine(m.caption), AD_LABEL);
  assert.deepEqual(m.buttons, [[{ text: 'Купити', url: 'https://shop.example.com' }]]);
});

test('renderSponsored: body text that tries to inject HTML is escaped', () => {
  const r = renderSponsored(creative({ body: [{ type: 'p', text: '<a href="https://evil">x</a> & co' }] }), makeCard(), { advertiser: 'a' });
  const m = r.messages[0];
  if (m.method !== 'sendMessage') return assert.fail('expected sendMessage');
  assert.ok(!m.text.includes('<a href="https://evil">'));
  assert.match(m.text, /&lt;a href=/);
});

test('sponsoredFooter: label only, or customer line + label', () => {
  assert.equal(sponsoredFooter({}), AD_LABEL);
  assert.equal(sponsoredFooter({ sponsorLabel: '  ' }), AD_LABEL);
  assert.equal(sponsoredFooter({ sponsorLabel: 'ФОП Іванов' }), `Реклама. Замовник: ФОП Іванов\n${AD_LABEL}`);
});

test('lintSponsored: no hashtag vocabulary / count rules, but media and length still checked', () => {
  const card = makeCard({ hashtags: ['космос'], hashtagMin: 1, hashtagMax: 2, bannedTerms: ['курс'] });
  const ok = lintSponsored(creative(), card);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));

  const noPhoto = lintSponsored(creative({ format: 'photo' }), card);
  assert.ok(noPhoto.errors.some((e) => e.code === 'media_count'));

  const long = lintSponsored(creative({ body: Array.from({ length: 6 }, () => ({ type: 'p', text: 'а'.repeat(900) })) }), card);
  assert.ok(long.errors.some((e) => e.code === 'too_long'));
});

test('lintSponsored: advertiser wording (banned terms, language) is a warning, not an error', () => {
  const r = lintSponsored(creative({ body: [{ type: 'p', text: 'Best online course in the modern world, join now and learn fast' }] }), makeCard());
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.code === 'not_ukrainian'));
});

test('lintSponsored: a raw object that does not parse is reported as invalid_creative', () => {
  const r = lintSponsored({ body: [], hashtags: ['x'] }, makeCard());
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, 'invalid_creative');
});

test('creativeFromText: legacy SP2 plain text becomes a one-block text creative', () => {
  const c = creativeFromText('Рядок 1\n\nРядок 2');
  assert.equal(c.format, 'text');
  assert.equal(c.body.length, 2);
  assert.equal(SponsoredCreativeSchema.safeParse(c).success, true);
});
