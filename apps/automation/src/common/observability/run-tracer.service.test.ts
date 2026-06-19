import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunTracer } from './run-tracer.service';
import { describeError } from './describe-error';

test('run() collects steps recorded inside it', async () => {
  const t = new RunTracer();
  const steps = await t.run(async () => {
    await t.span('A', 'one', async () => 'x');
    t.event('B', 'two', 'ok', 'detail');
  });
  assert.equal(steps.length, 2);
  assert.deepEqual(steps.map(s => [s.service, s.action, s.status]), [['A', 'one', 'ok'], ['B', 'two', 'ok']]);
  assert.deepEqual(steps.map(s => s.seq), [0, 1]);
});

test('span() returns the fn result and records an ok step with a duration', async () => {
  const t = new RunTracer();
  let result: number | undefined;
  const steps = await t.run(async () => { result = await t.span('S', 'a', async () => 42); });
  assert.equal(result, 42);
  assert.equal(steps[0].status, 'ok');
  assert.ok(typeof steps[0].durationMs === 'number');
});

test('span() records an error step AND rethrows', async () => {
  const t = new RunTracer();
  let threw = false;
  const steps = await t.run(async () => {
    try { await t.span('S', 'boom', async () => { throw new Error('kaboom'); }); }
    catch { threw = true; }
  });
  assert.equal(threw, true, 'span must rethrow');
  assert.equal(steps[0].status, 'error');
  assert.match(steps[0].error ?? '', /kaboom/);
});

test('event() with error status records without throwing', async () => {
  const t = new RunTracer();
  const steps = await t.run(async () => {
    t.event('GroupFanOut', 'publish:threads', 'error', new Error('no bot'));
  });
  assert.equal(steps[0].status, 'error');
  assert.match(steps[0].error ?? '', /no bot/);
});

test('span()/event() are a no-op passthrough outside a run (no store)', async () => {
  const t = new RunTracer();
  const out = await t.span('S', 'a', async () => 7); // not inside run()
  assert.equal(out, 7);
  t.event('S', 'b', 'ok'); // must not throw
  assert.deepEqual(t.steps(), []);
});

test('describeError extracts a Meta Graph code + subcode', () => {
  const err = { response: { data: { error: { message: 'Unsupported get request', code: 100, error_subcode: 33, type: 'GraphMethodException' } } } };
  const s = describeError(err);
  assert.match(s, /Unsupported get request/);
  assert.match(s, /#100/);
  assert.match(s, /sub 33/);
});

test('describeError handles a plain Error and a bare string', () => {
  assert.match(describeError(new Error('plain')), /plain/);
  assert.equal(describeError('just text'), 'just text');
});
