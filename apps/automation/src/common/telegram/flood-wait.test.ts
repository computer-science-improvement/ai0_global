import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errors } from 'telegram';
import { isFloodWait, FloodWindow, FloodWaitActiveError, DEFAULT_FLOOD_SECONDS } from './flood-wait';

test('isFloodWait: a real GramJS FloodWaitError → its seconds', () => {
  const err = new errors.FloodWaitError({ capture: 37, request: undefined });
  // The bug this replaces: errorMessage is the base-class "FLOOD", so the old
  // `errorMessage ?? message` + regex never saw "A wait of N seconds".
  assert.equal((err as any).errorMessage, 'FLOOD');
  assert.equal(isFloodWait(err), 37);
});

test('isFloodWait: FloodWaitError-like object (class name + seconds) → seconds', () => {
  class FloodWaitError extends Error { seconds = 120; }
  assert.equal(isFloodWait(new FloodWaitError('x')), 120);
});

test("isFloodWait: errorMessage 'FLOOD' with seconds → seconds", () => {
  assert.equal(isFloodWait({ errorMessage: 'FLOOD', code: 420, seconds: 15, message: 'whatever' }), 15);
});

test("isFloodWait: errorMessage 'FLOOD' without seconds → conservative default", () => {
  assert.equal(isFloodWait({ errorMessage: 'FLOOD', code: 420 }), DEFAULT_FLOOD_SECONDS);
});

test('isFloodWait: our own re-thrown error (floodWaitSeconds) → seconds', () => {
  assert.equal(isFloodWait(new FloodWaitActiveError(42, 'getHistory')), 42);
});

test('isFloodWait: message-only fallbacks (FLOOD_WAIT_N / "A wait of N seconds")', () => {
  assert.equal(isFloodWait(new Error('420: FLOOD_WAIT_300 (caused by messages.GetHistory)')), 300);
  assert.equal(isFloodWait(new Error('FLOOD_PREMIUM_WAIT_9')), 9);
  assert.equal(isFloodWait(new Error('A wait of 61 seconds is required')), 61);
});

test('isFloodWait: plain errors and non-errors → null', () => {
  assert.equal(isFloodWait(new Error('CHANNEL_INVALID')), null);
  assert.equal(isFloodWait({ errorMessage: 'CHANNEL_PRIVATE', code: 400 }), null);
  assert.equal(isFloodWait(undefined), null);
  assert.equal(isFloodWait('FLOOD'), null);
});

test('isFloodWait: per-chat SlowModeWaitError is NOT an account flood', () => {
  const err = new errors.SlowModeWaitError({ capture: 30, request: undefined });
  assert.equal(isFloodWait(err), null);
});

test('FloodWindow: trips, counts down, expires; never shortens', () => {
  let now = 1_000_000;
  const w = new FloodWindow(() => now);
  assert.equal(w.remaining(), 0);
  w.trip(30);
  assert.equal(w.remaining(), 30);
  now += 10_500;
  assert.equal(w.remaining(), 20);           // ceil(19.5)
  w.trip(5);                                 // shorter flood does not shorten the window
  assert.equal(w.remaining(), 20);
  now += 20_000;
  assert.equal(w.remaining(), 0);
});
