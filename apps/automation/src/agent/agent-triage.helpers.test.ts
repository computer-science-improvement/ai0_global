import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLandingAttribution, buildTriagePrompt, parseLandingRef, parseTriageResult, storedLandingRef } from './agent-triage.helpers';
import { buildAdDmUrl, DEFAULT_AD_MESSAGE } from '../config/landing-dm';

test('buildTriagePrompt embeds the message text and asks for JSON', () => {
  const { system, user } = buildTriagePrompt('Привіт, хочу рекламу у вашому каналі за 500 грн');
  assert.match(system, /JSON/);
  assert.match(system, /ad.*vp.*question.*spam.*other/s);
  assert.match(user, /500 грн/);
});

test('parseTriageResult parses valid JSON', () => {
  const r = parseTriageResult('{"category":"ad","summary":"s","fields":{"budget":"500"},"draftReply":"d","score":80}');
  assert.equal(r.category, 'ad');
  assert.equal(r.fields.budget, '500');
  assert.equal(r.score, 80);
});

test('parseTriageResult strips code fences', () => {
  const r = parseTriageResult('```json\n{"category":"vp","summary":"","fields":{},"draftReply":"","score":10}\n```');
  assert.equal(r.category, 'vp');
});

test('parseTriageResult falls back to other on garbage', () => {
  const r = parseTriageResult('not json at all');
  assert.equal(r.category, 'other');
  assert.equal(r.score, 0);
});

test('parseTriageResult clamps score and unknown category', () => {
  const r = parseTriageResult('{"category":"weird","summary":"","fields":{},"draftReply":"","score":999}');
  assert.equal(r.category, 'other');
  assert.equal(r.score, 100);
});

// ── Spec 026 FR-016 ──
test('parseLandingRef reads the placement and the optional channel key', () => {
  assert.deepEqual(parseLandingRef('Hi! I want an ad. [ai0web:hero]'), { placement: 'hero', channel: null });
  assert.deepEqual(parseLandingRef('x [ai0web:resource:space_ua] y'), { placement: 'resource', channel: 'space_ua' });
  assert.deepEqual(parseLandingRef('[ai0web:mediakit:@Space_UA]'), { placement: 'mediakit', channel: 'Space_UA' });
  assert.equal(parseLandingRef('no tag here'), null);
  assert.equal(parseLandingRef('[ai0web:X]'), null, 'placement is lower-case letters and _');
  assert.equal(parseLandingRef('[ai0web:hero:ab]'), null, 'a channel key needs 3+ characters');
  assert.equal(parseLandingRef(''), null);
  assert.equal(parseLandingRef(null), null);
});

test('parseLandingRef round-trips the links the landing builds (Cyrillic target, long title)', () => {
  const url = buildAdDmUrl({ username: 'ai0_ads', template: DEFAULT_AD_MESSAGE, target: 'Космос щодня & co #1', placement: 'resource', channelKey: '@space_ua' })!;
  const text = decodeURIComponent(url.split('?text=')[1]);
  assert.deepEqual(parseLandingRef(text), { placement: 'resource', channel: 'space_ua' });
  const long = buildAdDmUrl({ username: 'ai0_ads', template: DEFAULT_AD_MESSAGE, target: 'x'.repeat(500), placement: 'mediakit', channelKey: 'recipes_ua' })!;
  assert.deepEqual(parseLandingRef(decodeURIComponent(long.split('?text=')[1])), { placement: 'mediakit', channel: 'recipes_ua' });
});

test('applyLandingAttribution merges fields and forces ad only for attributed threads', () => {
  const base = { category: 'other' as const, summary: '', fields: { budget: '500' }, draftReply: '', score: 10 };
  const tagged = applyLandingAttribution(base, { placement: 'footer', channel: null }, null);
  assert.equal(tagged.category, 'ad');
  assert.deepEqual(tagged.fields, { budget: '500', source: 'landing', placement: 'footer' });

  const follow = applyLandingAttribution({ ...base, category: 'question', fields: {} }, null, tagged.fields);
  assert.equal(follow.category, 'ad');
  assert.equal(follow.fields.source, 'landing');
  assert.equal(follow.fields.budget, '500');

  const plain = applyLandingAttribution({ ...base, category: 'question' }, null, { budget: '1' });
  assert.equal(plain.category, 'question');
  assert.equal(plain.fields.source, undefined);
  assert.equal(applyLandingAttribution({ ...base, category: 'vp' }, { placement: 'hero', channel: null }, null).category, 'vp');
  assert.equal(storedLandingRef({ source: 'other' }), null);
});
