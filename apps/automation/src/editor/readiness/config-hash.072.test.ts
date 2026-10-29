import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, configHash } from './facts';
import { makeFacts, mkDataset, mkPlaybook, mkSeries, mkSkill, REF } from './testing/facts-fixture';

/** Spec 072 FR-002: the config hash covers the configuration parts of the facts and nothing that changes without a reconfiguration. */

const base = () => makeFacts({
  skills: [mkSkill({ id: 's1' }), mkSkill({ id: 's2', name: 'other-skill' })],
  datasets: [mkDataset()],
  playbook: mkPlaybook([mkSeries({ source: { kind: 'library', table: 'tips' } })]),
  rules: [{ id: 1, text: 'Never post on Sundays' }],
  steering: [{ id: 'set1/0', text: 'Keep it short' }],
  pins: [{ id: 'p1', format: 'text', source: null, active: true }],
});
const h0 = configHash(base());

test('the hash is a stable sha256 of the same facts', () => {
  assert.match(h0, /^[0-9a-f]{64}$/);
  assert.equal(configHash(base()), h0);
});

test('canonical JSON does not depend on key order', () => {
  assert.equal(canonical({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: undefined } }), canonical({ a: { c: undefined, d: [2, { x: 2, y: 1 }] }, b: 1 }));
  assert.equal(canonical({ a: 1, b: undefined }), '{"a":1}');
});

test('it changes with a skill toggled off, a skill switched to inline, and a new skill version', () => {
  const f = base();
  assert.notEqual(configHash({ ...f, skills: f.skills.slice(0, 1) }), h0, 'toggled off = gone from the enabled list');
  assert.notEqual(configHash({ ...f, skills: [{ ...f.skills[0], inline: true }, f.skills[1]] }), h0);
  assert.notEqual(configHash({ ...f, skills: [{ ...f.skills[0], version: 2 }, f.skills[1]] }), h0);
});

test('it changes with the card formats and the other card settings', () => {
  const f = base();
  assert.notEqual(configHash({ ...f, card: { ...f.card, formats: { ...f.card.formats, photo: 0 } } }), h0);
  assert.notEqual(configHash({ ...f, card: { ...f.card, hashtagMin: 0 } }), h0);
  assert.notEqual(configHash({ ...f, card: { ...f.card, toolsAllow: ['fetch_url'] } }), h0);
  assert.notEqual(configHash({ ...f, card: { ...f.card, sources: [{ id: 'f1', kind: 'rss', ref: 'https://example.com/rss' }] } }), h0);
});

test('it changes with post_requires, the reuse policy and the dataset version', () => {
  const f = base();
  const withDs = (over: object) => configHash({ ...f, datasets: [{ ...f.datasets[0], ...over }] });
  assert.notEqual(withDs({ postRequires: [['text'], ['image']] }), h0);
  assert.notEqual(withDs({ reusePolicy: { kind: 'cycle', order: 'sequential' } }), h0);
  assert.notEqual(withDs({ version: 2 }), h0);
});

test('it changes with the profile format_prefs, topic and language', () => {
  const f = base();
  assert.notEqual(configHash({ ...f, profile: { ...f.profile!, formatPrefs: { slang: true } } }), h0);
  assert.notEqual(configHash({ ...f, profile: { ...f.profile!, topic: 'Cooking' } }), h0);
  assert.notEqual(configHash({ ...f, profile: { ...f.profile!, language: 'en' } }), h0);
});

test('it changes with the playbook, a pending draft, pins, rules, steering, the loadout and the group mode', () => {
  const f = base();
  assert.notEqual(configHash({ ...f, playbook: { ...f.playbook!, version: 4 } }), h0);
  assert.notEqual(configHash({ ...f, playbook: { ...f.playbook!, body: mkPlaybook([mkSeries({ cadence: 'daily@11:00' })]) } }), h0);
  assert.notEqual(configHash({ ...f, pendingPlaybook: { id: 'pb2', createdAt: '2026-10-19T00:00:00.000Z' } }), h0);
  assert.notEqual(configHash({ ...f, pins: [] }), h0);
  assert.notEqual(configHash({ ...f, rules: [{ id: 1, text: 'Never post on Mondays' }] }), h0);
  assert.notEqual(configHash({ ...f, steering: [] }), h0);
  assert.notEqual(configHash({ ...f, loadoutTools: ['fetch_url'] }), h0);
  assert.notEqual(configHash({ ...f, group: { id: 'g1', name: 'Net', mode: 'topic' } }), h0);
});

test('the order of lists does not change it', () => {
  const f = base();
  assert.equal(configHash({ ...f, skills: [...f.skills].reverse() }), h0);
  assert.equal(configHash({ ...f, loadoutTools: ['b', 'a'] }), configHash({ ...f, loadoutTools: ['a', 'b'] }));
});

test('it does not change with the mode, models, budget, timestamps or the agent mode', () => {
  const f = base();
  assert.equal(configHash({ ...f, card: { ...f.card, mode: 'live' }, agent: { ...f.agent!, mode: 'live' } }), h0);
  assert.equal(configHash({ ...f, card: { ...f.card, models: { executor: 'x' } } }), h0);
  assert.equal(configHash({ ...f, card: { ...f.card, dailyBudgetUsd: 9 } }), h0);
  assert.equal(configHash({ ...f, card: { ...f.card, createdAt: new Date('2020-01-01') } }), h0);
  assert.equal(configHash({ ...f, card: { ...f.card, richUnsupported: true } }), h0);
  assert.equal(configHash({ ...f, now: new Date('2030-01-01') }), h0);
});

test('it does not change with pauses, counts, fill rate, ledger use, host blocks, slots or the launch', () => {
  const f = base();
  assert.equal(configHash({ ...f, pauses: [{ id: 'x', channelKey: f.channelKey, key: 'series:Daily tip', label: 'Daily tip', cause: 'owner', reason: 'r', streak: 0, pausedAt: new Date(), resumedAt: null, resumedBy: null }] }), h0);
  assert.equal(configHash({ ...f, datasets: [{ ...f.datasets[0], rows: 5, notPostable: 4, unusedPostable: 0, used28: 9, fillRate: { text: 0.1 } }] }), h0);
  assert.equal(configHash({ ...f, sources: [{ url: 'https://x.example/rss', kind: 'rss', origin: 'card', host: 'x.example', hostBlock: { reason: 'refused', until: '2030-01-01T00:00:00.000Z', strikes: 2 } }] }), h0);
  assert.equal(configHash({ ...f, planned: [{ id: 's1', scheduledAt: '2026-10-20T12:00:00.000Z', resourceRef: REF, format: 'text', seriesName: null, sourceHints: [], scheduleRuleId: null }] }), h0);
  assert.equal(configHash({ ...f, slots24h: [{ status: 'skipped', error: 'no_fresh_item', verdict: null, scheduledAt: '2026-10-20T08:00:00.000Z' }] }), h0);
  assert.equal(configHash({ ...f, launch: { id: 'l1', status: 'running', botState: null, graduation: null } }), h0);
});
