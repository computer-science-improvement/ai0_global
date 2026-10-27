/** Spec 070 FR-005: a SIGTERM / SIGINT during boot exits with 143 at once; the listeners are gone once Nest takes over. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { armBootSignals, BOOT_EXIT_CODE } from './boot-signals';

function rig() {
  const target = new EventEmitter();
  const logs: string[] = [];
  const exits: number[] = [];
  const disarm = armBootSignals((m) => logs.push(m), (c) => exits.push(c), target as any);
  return { target, logs, exits, disarm };
}

test('SIGTERM during boot logs «shutdown during boot» and exits with 143', () => {
  const { target, logs, exits } = rig();
  assert.equal(target.listenerCount('SIGTERM'), 1);
  assert.equal(target.listenerCount('SIGINT'), 1);
  target.emit('SIGTERM');
  assert.equal(BOOT_EXIT_CODE, 143);
  assert.deepEqual(exits, [143]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^shutdown during boot \(SIGTERM\)$/);
});

test('SIGINT during boot does the same', () => {
  const { target, logs, exits } = rig();
  target.emit('SIGINT');
  assert.deepEqual(exits, [143]);
  assert.match(logs[0], /shutdown during boot \(SIGINT\)/);
});

test('disarm removes both listeners: after it a signal is the shutdown hooks\' business, not ours', () => {
  const { target, logs, exits, disarm } = rig();
  disarm();
  assert.equal(target.listenerCount('SIGTERM'), 0);
  assert.equal(target.listenerCount('SIGINT'), 0);
  // Nest's own listener (enableShutdownHooks) is the only one left.
  let graceful = 0;
  target.once('SIGTERM', () => { graceful++; });
  target.emit('SIGTERM');
  assert.equal(graceful, 1);
  assert.deepEqual(exits, []);
  assert.deepEqual(logs, []);
});

test('the listeners fire once each (process.once), and disarm leaves other listeners alone', () => {
  const { target, exits, disarm } = rig();
  const other = () => undefined;
  target.on('SIGTERM', other);
  target.emit('SIGTERM');
  target.emit('SIGTERM');
  assert.deepEqual(exits, [143], 'once');
  disarm();
  assert.equal(target.listenerCount('SIGTERM'), 1);
  assert.ok(target.listeners('SIGTERM').includes(other));
});

test('main.ts keeps the handler armed through app.init() (the onModuleInit hooks) and disarms it right before the shutdown hooks and listen (source order guard)', () => {
  // main.ts boots the whole app at import, so it cannot be run in a test; this pins the order of its calls instead.
  const src = readFileSync(join(__dirname, 'main.ts'), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const at = (needle: string) => {
    const i = src.indexOf(needle);
    assert.ok(i >= 0, `main.ts has ${needle}`);
    return i;
  };
  const lastUse = Math.max(src.lastIndexOf('app.use('), src.lastIndexOf('app.enableCors('), src.lastIndexOf('app.useGlobalPipes('), src.lastIndexOf('SwaggerModule.setup('));
  const arm = at('armBootSignals(');
  const create = at('NestFactory.create');
  const init = at('await app.init()');
  const disarm = at('disarmBootSignals();');
  const hooks = at('app.enableShutdownHooks()');
  const listen = at('await app.listen(');
  assert.ok(arm < create, 'armed before the app is created');
  assert.ok(lastUse < init, 'init() runs after all middleware, CORS, pipes and Swagger are set up (middleware added later would not apply)');
  assert.ok(init < disarm, 'the handler stays armed while init() runs the onModuleInit hooks');
  assert.ok(disarm < hooks && hooks < listen, 'disarm, then the shutdown hooks, then listen');
  assert.equal(src.split('disarmBootSignals();').length - 1, 1, 'disarmed in one place only');
});

test('with the real process: arming adds one listener per signal and disarming removes exactly those', () => {
  const before = [process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')];
  const disarm = armBootSignals(() => undefined, () => undefined);
  assert.deepEqual([process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')], [before[0] + 1, before[1] + 1]);
  disarm();
  assert.deepEqual([process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')], before);
});
