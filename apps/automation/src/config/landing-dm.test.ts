// Spec 026 FR-003: the Telegram DM link builder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AD_MESSAGE_MAX, DEFAULT_AD_MESSAGE, buildAdDmUrl, buildLandingRef, isLandingPlacement,
  normalizeTgUsername, renderAdMessage, validateAdTemplate,
} from './landing-dm';

const textOf = (url: string) => new URL(url).searchParams.get('text') ?? '';

test('username validation and normalization', () => {
  assert.equal(normalizeTgUsername('ai0_ads'), 'ai0_ads');
  assert.equal(normalizeTgUsername('  @Ai0Ads  '), 'Ai0Ads');
  assert.equal(normalizeTgUsername('https://t.me/ai0_ads'), 'ai0_ads');
  assert.equal(normalizeTgUsername('t.me/ai0_ads/'), 'ai0_ads');
  assert.equal(normalizeTgUsername('abcd'), null, 'too short (5 minimum)');
  assert.equal(normalizeTgUsername('a'.repeat(33)), null, 'too long (32 maximum)');
  assert.equal(normalizeTgUsername('a'.repeat(32)), 'a'.repeat(32));
  assert.equal(normalizeTgUsername('1abcde'), null, 'must start with a letter');
  assert.equal(normalizeTgUsername('ab cde'), null);
  assert.equal(normalizeTgUsername('ab-cde'), null);
  assert.equal(normalizeTgUsername('ім_яканалу'), null, 'Cyrillic is not a Telegram username');
  assert.equal(normalizeTgUsername(''), null);
  assert.equal(normalizeTgUsername(null), null);
  assert.equal(normalizeTgUsername(42), null);
});

test('no valid username, no link', () => {
  assert.equal(buildAdDmUrl({ username: null, template: DEFAULT_AD_MESSAGE, placement: 'hero' }), null);
  assert.equal(buildAdDmUrl({ username: 'bad name', template: DEFAULT_AD_MESSAGE, placement: 'hero' }), null);
});

test('the default message for a network placement', () => {
  const url = buildAdDmUrl({ username: '@ai0_ads', template: DEFAULT_AD_MESSAGE, placement: 'hero' })!;
  assert.ok(url.startsWith('https://t.me/ai0_ads?text='));
  assert.equal(textOf(url), "Hi! I'd like to order an ad in the ai0 network. [ai0web:hero]");
});

test('a channel target and its ref tag', () => {
  const url = buildAdDmUrl({ username: 'ai0_ads', template: DEFAULT_AD_MESSAGE, target: 'Space Daily', placement: 'resource', channelKey: '@space_daily' })!;
  assert.equal(textOf(url), "Hi! I'd like to order an ad in Space Daily. [ai0web:resource:space_daily]");
  assert.equal(buildLandingRef('mediakit', 'x'), '[ai0web:mediakit]', 'a key the tag regex cannot carry is dropped');
  assert.equal(buildLandingRef('mediakit', 'news-ua'), '[ai0web:mediakit]');
  assert.equal(buildLandingRef('network', null), '[ai0web:network]');
});

test('Cyrillic, &, #, newlines and $-patterns survive the round trip', () => {
  const template = 'Привіт!\nХочу рекламу в {target} & ще #реклама? {ref}';
  const target = 'Космос & Наука #1 $& $1';
  const url = buildAdDmUrl({ username: 'ai0_ads', template, target, placement: 'mediakit', channelKey: 'kosmos_ua' })!;
  // Nothing in the query is left unencoded: & and # would end the parameter or the URL.
  const query = url.slice(url.indexOf('?text=') + 6);
  assert.doesNotMatch(query, /[&#\s?]/);
  assert.match(query, /%0A/);
  assert.equal(textOf(url), 'Привіт!\nХочу рекламу в Космос & Наука #1 $& $1 & ще #реклама? [ai0web:mediakit:kosmos_ua]');
});

test('a template without {ref} still carries the tag', () => {
  assert.equal(renderAdMessage({ template: 'Ad in {target}, please.', target: 'X', ref: '[ai0web:footer]' }), 'Ad in X, please. [ai0web:footer]');
});

test('the 300-character cap shortens the target and keeps the tag whole', () => {
  const ref = buildLandingRef('resource', 'a_very_long_channel_key_for_testing');
  const long = 'Дуже довга назва каналу '.repeat(30);
  const msg = renderAdMessage({ template: DEFAULT_AD_MESSAGE, target: long, ref });
  assert.ok(Array.from(msg).length <= AD_MESSAGE_MAX, `length ${Array.from(msg).length}`);
  assert.ok(msg.endsWith(ref), 'the tag is the untouched tail');
  assert.ok(msg.startsWith("Hi! I'd like to order an ad in Дуже довга"));
  assert.match(msg, /…\. \[ai0web:/);
  // Emoji are never split in half.
  const emoji = renderAdMessage({ template: DEFAULT_AD_MESSAGE, target: '🚀'.repeat(400), ref });
  assert.ok(Array.from(emoji).length <= AD_MESSAGE_MAX);
  assert.doesNotMatch(emoji, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, 'no lone high surrogate');
  // Two {target} occurrences share the room.
  const twice = renderAdMessage({ template: '{target} / {target} {ref}', target: 'x'.repeat(500), ref });
  assert.ok(Array.from(twice).length <= AD_MESSAGE_MAX);
  assert.ok(twice.endsWith(ref));
});

test('a fixed text over the cap is cut before the tag', () => {
  const ref = '[ai0web:hero]';
  const msg = renderAdMessage({ template: `${'w'.repeat(320)} {target} {ref}`, target: 'T', ref });
  assert.equal(Array.from(msg).length, AD_MESSAGE_MAX);
  assert.ok(msg.endsWith(`… ${ref}`));
});

test('template validation', () => {
  assert.deepEqual(validateAdTemplate(DEFAULT_AD_MESSAGE), []);
  assert.deepEqual(validateAdTemplate('Hello {target}'), [], '{ref} is optional (it is appended)');
  assert.equal(validateAdTemplate('   ').length, 1);
  assert.match(validateAdTemplate('Hi {channel} {ref}')[0], /Unknown placeholder \{channel\}/);
  assert.match(validateAdTemplate('x'.repeat(241))[0], /longer than 240/);
});

test('placements', () => {
  for (const p of ['hero', 'topbar', 'network', 'resource', 'mediakit', 'advertise', 'footer', 'howitworks']) assert.ok(isLandingPlacement(p));
  assert.equal(isLandingPlacement('sidebar'), false);
  assert.equal(isLandingPlacement(undefined), false);
});
