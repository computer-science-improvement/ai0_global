import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadinessWorker } from './readiness.worker';

/** Spec 072 T6, FR-006: the sweep tick runs nothing when the editor is off, never twice at once, and never throws. */

const cfg = (enabled: string | undefined) => ({ get: (k: string) => (k === 'EDITOR_ENABLED' ? enabled : undefined) }) as any;

test('nothing runs while EDITOR_ENABLED is off or unset', async () => {
  let sweeps = 0;
  const svc = { sweep: async () => { sweeps++; return { checked: 0, failed: 0 }; } } as any;
  await new ReadinessWorker(svc, cfg('false')).tick();
  await new ReadinessWorker(svc, cfg(undefined)).tick();
  assert.equal(sweeps, 0);
});

test('with the editor on, a tick runs one sweep', async () => {
  let sweeps = 0;
  await new ReadinessWorker({ sweep: async () => { sweeps++; return { checked: 2, failed: 0 }; } } as any, cfg('true')).tick();
  assert.equal(sweeps, 1);
});

test('a sweep that throws is swallowed, and the next tick runs again', async () => {
  let sweeps = 0;
  const w = new ReadinessWorker({ sweep: async () => { sweeps++; throw new Error('db down'); } } as any, cfg('true'));
  await w.tick();
  await w.tick();
  assert.equal(sweeps, 2);
});

test('a tick while the last sweep is still running does nothing', async () => {
  let sweeps = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const w = new ReadinessWorker({ sweep: async () => { sweeps++; await gate; return { checked: 1, failed: 0 }; } } as any, cfg('true'));
  const first = w.tick();
  await w.tick();
  assert.equal(sweeps, 1);
  release();
  await first;
  await w.tick();
  assert.equal(sweeps, 2);
});
