import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOpportunityCandidate, buildOpportunityPrompt, parseOpportunity } from './chat-intel.helpers';

test('isOpportunityCandidate true for ad/vp/price texts', () => {
  assert.equal(isOpportunityCandidate('Шукаю рекламу у вашому каналі'), true);
  assert.equal(isOpportunityCandidate('Пропоную ВП (взаємний піар)'), true);
  assert.equal(isOpportunityCandidate('Прайс: 500 грн за пост'), true);
  assert.equal(isOpportunityCandidate('розміщення від 1000₴'), true);
});
test('isOpportunityCandidate false for ordinary chatter', () => {
  assert.equal(isOpportunityCandidate('Привіт, як справи?'), false);
  assert.equal(isOpportunityCandidate('Дякую за допомогу!'), false);
});
test('buildOpportunityPrompt asks for JSON + lists kinds', () => {
  const { system, user } = buildOpportunityPrompt('Шукаю рекламу 500 грн');
  assert.match(system, /JSON/);
  assert.match(system, /ad_offer.*vp_request.*pricing.*other/s);
  assert.match(user, /500 грн/);
});
test('parseOpportunity valid / garbage / clamp / unknown', () => {
  const ok = parseOpportunity('{"kind":"ad_offer","summary":"s","score":80,"suggestedAction":"advertise"}');
  assert.equal(ok.kind, 'ad_offer'); assert.equal(ok.suggestedAction, 'advertise');
  const bad = parseOpportunity('not json');
  assert.equal(bad.kind, 'other'); assert.equal(bad.score, 0); assert.equal(bad.suggestedAction, 'skip');
  const clamp = parseOpportunity('{"kind":"weird","score":999,"suggestedAction":"nope"}');
  assert.equal(clamp.kind, 'other'); assert.equal(clamp.score, 100); assert.equal(clamp.suggestedAction, 'skip');
});
