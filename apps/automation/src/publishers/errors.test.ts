import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChannelPausedError, RunSkippedError, isPermanentTelegramError, isRunSkippedError, runOutcomeForError,
} from './errors';

test('RunSkippedError is detected by name (survives lost prototypes)', () => {
  assert.equal(isRunSkippedError(new RunSkippedError('cooldown')), true);
  const plain = Object.assign(new Error('x'), { name: 'RunSkippedError' });
  assert.equal(isRunSkippedError(plain), true);
  assert.equal(isRunSkippedError(new Error('x')), false);
});

test('isPermanentTelegramError: content/media rejections are permanent; channel-level and transient ones are not', () => {
  const axiosErr = (description: string) =>
    Object.assign(new Error('Request failed with status code 400'), { response: { data: { description } } });
  for (const e of [
    axiosErr("Bad Request: can't parse entities: Unsupported start tag \"x\" at byte offset 3"),
    axiosErr('Bad Request: message caption is too long'),
    axiosErr('Bad Request: PHOTO_INVALID_DIMENSIONS'),
    axiosErr('Bad Request: wrong file identifier/HTTP URL specified'),
    new Error('Publish blocked: text too short (3 chars)'),
  ]) assert.equal(isPermanentTelegramError(e), true, e.message);
  for (const e of [
    axiosErr('Bad Request: chat not found'),
    axiosErr('Forbidden: bot is not a member of the channel chat'),
    axiosErr('Too Many Requests: retry after 30'),
    new Error('timeout of 30000ms exceeded'),
    new ChannelPausedError('@c'),
  ]) assert.equal(isPermanentTelegramError(e), false, e.message);
});

test('runOutcomeForError: paused channel and cooldown skips are "skipped", everything else "error"', () => {
  assert.equal(runOutcomeForError(new ChannelPausedError('@c')), 'skipped');
  assert.equal(runOutcomeForError(new RunSkippedError('cooldown')), 'skipped');
  assert.equal(runOutcomeForError(new Error('boom')), 'error');
  assert.equal(runOutcomeForError('weird'), 'error');
});
