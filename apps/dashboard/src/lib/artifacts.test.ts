// Spec 048 FR-005: artifact references, the panel's URL param and the version text the diff compares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artifactMention, artifactParam, artifactView, inView, parseArtifactParam, versionText } from './artifacts';
import { mentionedArtifacts } from '../components/artifacts/ArtifactChip';

test('the panel param and the composer reference round-trip; unknown types are refused', () => {
  assert.deepEqual(parseArtifactParam(artifactParam('rules', '@news')), { type: 'rules', id: '@news' });
  assert.deepEqual(parseArtifactParam('profile:telegram:@news'), { type: 'profile', id: 'telegram:@news' });
  assert.equal(parseArtifactParam('nope:1'), null);
  assert.equal(parseArtifactParam('steering:'), null);
  assert.equal(artifactMention('steering', 'abc'), '[[steering:abc]]');
  assert.deepEqual(mentionedArtifacts('why [[steering:abc]] and [[rules:@news]], again [[steering:abc]] [[x:1]]').map((c) => `${c.type}:${c.id}`), ['steering:abc', 'rules:@news']);
});

test('version text: skill bodies as text, rules and steering one line each, the rest as JSON', () => {
  assert.equal(versionText('skill', { body: 'Line 1\nLine 2', description: 'd' }), 'Line 1\nLine 2');
  assert.equal(versionText('rules', [{ id: 3, text: 'No emoji' }, { id: 4, text: 'Short' }]), '#3 No emoji\n#4 Short');
  assert.equal(versionText('steering', { status: 'active', summary: null, rules: [{ id: 's1', kind: 'hook', text: 'Ask', enabled: false }] }), 'status: active\ns1 [hook] (off) Ask');
  assert.equal(versionText('profile', { topic: 'AI' }), '{\n  "topic": "AI"\n}');
});

test('status views: ready and pending wait for the owner, discarded and failed are closed, the rest is in use', () => {
  assert.equal(artifactView('ready'), 'needs-you');
  assert.equal(artifactView('pending_owner'), 'needs-you');
  assert.equal(artifactView('failed'), 'closed');
  assert.equal(artifactView('superseded'), 'closed');
  assert.equal(artifactView('active'), 'in-use');
  assert.equal(artifactView('analyzing'), 'in-use');
  assert.ok(inView('all', 'discarded'));
  assert.ok(!inView('in-use', 'discarded'));
});
