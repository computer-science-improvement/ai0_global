import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelPausedError, RunSkippedError, isRunSkippedError, runOutcomeForError } from './errors';

test('RunSkippedError is detected by name (survives lost prototypes)', () => {
  assert.equal(isRunSkippedError(new RunSkippedError('cooldown')), true);
  const plain = Object.assign(new Error('x'), { name: 'RunSkippedError' });
  assert.equal(isRunSkippedError(plain), true);
  assert.equal(isRunSkippedError(new Error('x')), false);
});

test('runOutcomeForError: paused channel and cooldown skips are "skipped", everything else "error"', () => {
  assert.equal(runOutcomeForError(new ChannelPausedError('@c')), 'skipped');
  assert.equal(runOutcomeForError(new RunSkippedError('cooldown')), 'skipped');
  assert.equal(runOutcomeForError(new Error('boom')), 'error');
  assert.equal(runOutcomeForError('weird'), 'error');
});
