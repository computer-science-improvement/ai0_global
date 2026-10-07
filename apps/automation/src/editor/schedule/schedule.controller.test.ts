import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { ScheduleController } from './schedule.controller';

// Spec 023 FR-007: the Schedule REST maps service failures to their status with { error, details }.

const SCOPE = { agent: { id: 'a1', handle: 'chef' }, card: {}, net: {} };

function controller(over: Record<string, unknown> = {}) {
  const calls: unknown[][] = [];
  const svc: any = {
    scopeByHandle: async (h: string) => (h === 'chef' ? SCOPE : { error: 'agent_not_found', details: h, status: 404 }),
    schedule: async (...a: unknown[]) => { calls.push(['schedule', ...a]); return { from: '2026-10-07' }; },
    addRule: async (...a: unknown[]) => { calls.push(['addRule', ...a]); return { error: 'rule_invalid', details: ['a pin needs at_local (HH:MM)'], status: 400 }; },
    updateRule: async (...a: unknown[]) => { calls.push(['updateRule', ...a]); return { rule: { id: 'r1' }, warnings: [] }; },
    putSeries: async (...a: unknown[]) => { calls.push(['putSeries', ...a]); return { ok: true, version: 4 }; },
    unlockSeries: async () => ({ error: 'not_locked', details: 'already the agent\'s', status: 409 }),
    ...over,
  };
  return { c: new ScheduleController(svc), calls };
}

async function status(p: Promise<unknown>): Promise<[number, unknown]> {
  try { await p; return [200, null]; } catch (e) { assert.ok(e instanceof HttpException); return [e.getStatus(), e.getResponse()]; }
}

test('schedule REST: scope, rule failures and conflicts carry their status and body', async () => {
  const { c, calls } = controller();
  assert.deepEqual(await c.schedule('chef', '2026-10-07', undefined), { from: '2026-10-07' });
  assert.deepEqual(calls[0], ['schedule', SCOPE, { from: '2026-10-07', to: null }]);
  assert.deepEqual(await status(c.schedule('nobody')), [404, { error: 'agent_not_found', details: 'nobody' }]);
  assert.deepEqual(await status(c.addRule('chef', { kind: 'pin' })), [400, { error: 'rule_invalid', details: ['a pin needs at_local (HH:MM)'] }]);
  assert.deepEqual(await c.updateRule('chef', '6b1d1b0e-3f2a-4c55-9d8e-1a2b3c4d5e6f', { active: false }), { rule: { id: 'r1' }, warnings: [] });
  assert.deepEqual(await c.putSeries('chef', 'Рецепт дня', { cadence: 'daily@20:00' }), { ok: true, version: 4 });
  assert.deepEqual(calls.at(-1), ['putSeries', SCOPE, 'Рецепт дня', { cadence: 'daily@20:00' }]);
  assert.equal((await status(c.unlock('chef', 'Рецепт дня')))[0], 409);
});
