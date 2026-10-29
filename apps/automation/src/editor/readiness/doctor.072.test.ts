import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding } from '../sysadmin/audit.types';
import { findingKey } from '../sysadmin/audit-text';
import { DOCTOR_CHECKS, type DoctorCheck } from './checks';
import { channelDoctor } from './doctor';
import { mkFinding } from './finding';
import { DOCTOR_REASONS } from './codes';
import { NANOBANANA_SKILL, PROMPTHERO_SKILL } from './fixtures/real-skills-1027';
import { deepFreeze, makeFacts, mkDataset, mkPlaybook, mkSkill, NOW, promptSeries } from './testing/facts-fixture';

/** Spec 072 FR-003, L5: the doctor runs the checks, drops repeated keys, sorts, and does nothing else. */

const fake = (code: string, sev: Finding['severity'], id: string): Finding => mkFinding(makeFacts(), { code, severity: sev, subject: { type: 'channel', id, label: id }, detail: `${code} ${id}` });
const one = (...list: Finding[]): DoctorCheck => ({ code: 'x', run: () => list });

test('a healthy channel has no findings', () => {
  assert.deepEqual(channelDoctor(makeFacts()), []);
});

test('findings are sorted error, warn, info, then by code, subject and key', () => {
  const f = makeFacts();
  const out = channelDoctor(f, [one(
    fake('series_paused', 'info', 'z'),
    fake('material_low', 'warn', 'b'),
    fake('material_low', 'warn', 'a'),
    fake('dataset_low_fill', 'error', 'q'),
    fake('bot_not_admin', 'error', 'q'),
    fake('series_paused', 'info', 'a'),
  )]);
  assert.deepEqual(out.map((x) => `${x.severity}:${x.check}:${x.subject.id}`), [
    'error:bot_not_admin:q',
    'error:dataset_low_fill:q',
    'warn:material_low:a',
    'warn:material_low:b',
    'info:series_paused:a',
    'info:series_paused:z',
  ]);
});

test('a finding whose key was already seen is dropped, the first one stays', () => {
  const a = fake('material_low', 'warn', 'a');
  const dup = { ...a, detail: 'second' };
  const out = channelDoctor(makeFacts(), [one(a), one(dup)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].detail, a.detail);
});

test('the same facts always give the same list, in the same order, whatever the order of the checks', () => {
  const facts = makeFacts({
    playbook: mkPlaybook([promptSeries({ source_mode: 'suggested' })]),
    skills: [mkSkill({ id: PROMPTHERO_SKILL.id, name: PROMPTHERO_SKILL.name, description: PROMPTHERO_SKILL.description, body: PROMPTHERO_SKILL.body }), mkSkill({ id: NANOBANANA_SKILL.id, name: NANOBANANA_SKILL.name, description: NANOBANANA_SKILL.description, body: NANOBANANA_SKILL.body })],
    datasets: [mkDataset({ key: 'prompts', unusedPostable: 0 })],
  });
  const a = channelDoctor(facts);
  const b = channelDoctor(facts);
  const c = channelDoctor(facts, [...DOCTOR_CHECKS].reverse());
  assert.ok(a.length >= 3);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.equal(new Set(a.map((x) => x.key)).size, a.length, 'keys are unique');
});

test('every finding is a catalogue code on the channel area with a key that hashes its own subject', () => {
  const facts = makeFacts({
    playbook: mkPlaybook([promptSeries()]),
    skills: [mkSkill({ id: PROMPTHERO_SKILL.id, name: PROMPTHERO_SKILL.name, description: PROMPTHERO_SKILL.description, body: PROMPTHERO_SKILL.body })],
    datasets: [mkDataset({ key: 'prompts', unusedPostable: 0 })],
  });
  const known = new Set(DOCTOR_REASONS.map((r) => r.code));
  for (const x of channelDoctor(facts)) {
    assert.equal(x.area, 'channel');
    assert.ok(known.has(x.check), x.check);
    assert.equal(x.key, findingKey('channel', x.check, x.subject));
    assert.equal(x.subject.channel, facts.channelKey);
  }
});

test('a channel with a fault for every check file gets a finding from each of the seven', () => {
  const facts = makeFacts({
    card: { toolsAllow: ['web_fetch'], hashtagMin: 2, hashtags: [] },
    playbook: mkPlaybook([promptSeries({ source_mode: 'suggested' })]),
    skills: [mkSkill({ id: PROMPTHERO_SKILL.id, name: PROMPTHERO_SKILL.name, description: PROMPTHERO_SKILL.description, body: PROMPTHERO_SKILL.body })],
    datasets: [mkDataset({ key: 'prompts', unusedPostable: 0 })],
    pauses: [{ id: 'p9', channelKey: '@fx072', key: 'series:Prompt', label: 'Prompt', cause: 'owner', reason: '', streak: 0, pausedAt: NOW, resumedAt: null, resumedBy: null }],
    launch: { id: 'l1', status: 'ready', botState: { state: 'no_access', detail: 'x', bot: null }, graduation: null },
  });
  const got = new Set(channelDoctor(facts).map((x) => x.check));
  for (const code of ['series_source_contradicted', 'series_source_not_required', 'material_exhausted', 'tools_missing_for_source', 'hashtag_min_without_vocabulary', 'series_paused_by_owner', 'bot_not_admin']) {
    assert.ok(got.has(code), code);
  }
  const out = channelDoctor(facts);
  assert.equal(out[0].severity, 'error');
  assert.equal(out[out.length - 1].severity, 'info');
});

test('the doctor does not change the facts it reads', () => {
  const facts = deepFreeze(makeFacts({ playbook: mkPlaybook([promptSeries()]), datasets: [mkDataset({ key: 'prompts', unusedPostable: 0 })] }));
  assert.doesNotThrow(() => channelDoctor(facts));
});

test('the doctor reads no clock: the same facts at another real time give the same findings', async () => {
  const facts = makeFacts({ playbook: mkPlaybook([promptSeries({ source_mode: 'suggested' })]), pendingPlaybook: { id: 'd', createdAt: '2026-10-18T00:00:00.000Z' } });
  const real = Date.now;
  const a = channelDoctor(facts);
  Date.now = () => real() + 400 * 86_400_000;
  try {
    assert.deepEqual(channelDoctor(facts), a);
  } finally {
    Date.now = real;
  }
  assert.ok(a.some((x) => x.check === 'playbook_draft_waiting'));
});

test('the doctor, its checks and the source judgement import no database and read no clock (L5)', () => {
  const dir = __dirname;
  const files = [
    join(dir, 'doctor.ts'), join(dir, 'source-contradiction.ts'), join(dir, 'finding.ts'),
    ...readdirSync(join(dir, 'checks')).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts')).map((n) => join(dir, 'checks', n)),
  ];
  assert.ok(files.length >= 6);
  for (const file of files) {
    const code = readFileSync(file, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.doesNotMatch(code, /from\s+['"]pg['"]/, `${file} imports pg`);
    assert.doesNotMatch(code, /Date\.now\s*\(/, `${file} reads the clock`);
    assert.doesNotMatch(code, /new Date\s*\(\s*\)/, `${file} reads the clock`);
    assert.doesNotMatch(code, /\.query\s*\(/, `${file} queries`);
    assert.doesNotMatch(code, /\bfetch\s*\(/, `${file} calls the network`);
    assert.doesNotMatch(code, /\bPool\b/, `${file} holds a pool`);
  }
});
