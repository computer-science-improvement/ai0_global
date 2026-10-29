import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFacts, mkPlaybook, mkSeries, NOW, promptSeries } from '../testing/facts-fixture';
import { DRAFT_WAIT_MS, seriesCheck } from './series';

/** Spec 072 FR-003.2: series_source_not_required and playbook_draft_waiting. */

const run = (init: Parameters<typeof makeFacts>[0]) => seriesCheck.run(makeFacts(init));
const draft = (ageMs: number) => ({ id: 'draft1', createdAt: new Date(NOW.getTime() - ageMs).toISOString() } as never);

test('a library series that is only suggested is a warning with the series_source_require fix', () => {
  const [x, ...rest] = run({ playbook: mkPlaybook([promptSeries({ source_mode: 'suggested' })]) });
  assert.equal(rest.length, 0);
  assert.equal(x.check, 'series_source_not_required');
  assert.equal(x.severity, 'warn');
  assert.equal(x.area, 'channel');
  assert.deepEqual(x.subject, { type: 'playbook', id: 'Prompt', label: 'Prompt', agent: 'fx072', channel: '@fx072' });
  assert.deepEqual(x.fix, { kind: 'series_source_require', channel: '@fx072', series: 'Prompt' });
  assert.equal(x.link, '/app/agents/fx072?tab=schedule');
  assert.deepEqual(x.evidence, { series: 'Prompt', dataset: 'prompts', source_mode: 'suggested', origin: 'owner', locked: true });
});

test('a library series that says nothing about source_mode is suggested by default and reported', () => {
  const out = run({ playbook: mkPlaybook([promptSeries({ source_mode: undefined })]) });
  assert.equal(out.length, 1);
  assert.equal((out[0].evidence as any).source_mode, 'suggested');
});

test('required, inactive, free, feed and absent sources are left alone', () => {
  const out = run({ playbook: mkPlaybook([
    promptSeries(),
    promptSeries({ name: 'Off', source_mode: 'suggested', active: false }),
    mkSeries({ name: 'Free', source: { kind: 'free' }, source_mode: 'suggested' }),
    mkSeries({ name: 'Feed', source: { kind: 'feed', ref: 'feed1' }, source_mode: 'suggested' }),
    mkSeries({ name: 'None' }),
  ]) });
  assert.deepEqual(out, []);
});

test('two library series give two findings with different keys', () => {
  const out = run({ playbook: mkPlaybook([promptSeries({ source_mode: 'suggested' }), promptSeries({ name: 'Prompt 2', source_mode: 'suggested' })]) });
  assert.equal(out.length, 2);
  assert.notEqual(out[0].key, out[1].key);
});

test('a series of another resource is not this channel\'s', () => {
  const out = run({ playbook: mkPlaybook([promptSeries({ source_mode: 'suggested', resource_ref: 'telegram:@other' })]) });
  assert.deepEqual(out, []);
});

test('a playbook draft waiting more than 24 hours is a warning, exactly 24 hours is not', () => {
  const [x] = run({ pendingPlaybook: draft(DRAFT_WAIT_MS + 3_600_000 * 5) });
  assert.equal(x.check, 'playbook_draft_waiting');
  assert.equal(x.severity, 'warn');
  assert.deepEqual(x.subject, { type: 'playbook', id: 'draft1', label: 'Playbook draft', agent: 'fx072', channel: '@fx072' });
  assert.equal(x.fix, undefined);
  assert.equal(x.link, '/app/agents/fx072?tab=playbook');
  assert.equal((x.evidence as any).waiting_hours, 29);
  assert.match(x.detail, /29 hours/);
  assert.deepEqual(run({ pendingPlaybook: draft(DRAFT_WAIT_MS) }), []);
  assert.equal(run({ pendingPlaybook: draft(DRAFT_WAIT_MS + 1) }).length, 1);
  assert.deepEqual(run({ pendingPlaybook: draft(3_600_000) }), []);
});

test('no draft, or a draft with an unreadable date, gives nothing', () => {
  assert.deepEqual(run({ pendingPlaybook: null }), []);
  assert.deepEqual(run({ pendingPlaybook: { id: 'd', createdAt: 'not a date' } as never }), []);
});

test('the age is counted against facts.now and not the real clock', () => {
  const later = new Date(NOW.getTime() + 3 * DRAFT_WAIT_MS);
  const base = { id: 'd', createdAt: NOW.toISOString() } as never;
  assert.deepEqual(run({ pendingPlaybook: base }), []);
  assert.equal(run({ pendingPlaybook: base, now: later }).length, 1);
});
