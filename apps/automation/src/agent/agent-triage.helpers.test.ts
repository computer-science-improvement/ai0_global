import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTriagePrompt, parseTriageResult } from './agent-triage.helpers';

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
