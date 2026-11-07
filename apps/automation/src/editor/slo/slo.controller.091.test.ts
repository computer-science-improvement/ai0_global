// Spec 091 FR-008: GET /api/editor/slo on a fake repository — the day's rows, the 7-day history, the Kyiv default day, a bad day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import type { ChannelSloRow } from './channel-slo.repository';
import { SloController } from './slo.controller';

const row = (o: Partial<ChannelSloRow> = {}): ChannelSloRow => ({
  channelKey: '@a', day: '2026-11-07', target: 2, published: 1, plannedAhead: 0, skipped: 1, replacements: 1, recoveryRuns: 0, state: 'behind',
  reason: 'one slot skipped', lastPostAt: new Date('2026-11-07T08:00:00Z'), darkSince: null, updatedAt: new Date('2026-11-07T09:00:00Z'), ...o,
});

function setup() {
  const asked: any[] = [];
  const repo: any = {
    async forDay(d: string) { asked.push(['forDay', d]); return [row({ day: d })]; },
    async history(d: string, n: number) { asked.push(['history', d, n]); return [row({ day: d }), row({ day: '2026-11-06', state: 'met', published: 2 })]; },
  };
  return { c: new SloController(repo), asked };
}

test('returns the day, its rows and the 7-day history with ISO dates', async () => {
  const { c, asked } = setup();
  const r = await c.get('2026-11-07');
  assert.equal(r.day, '2026-11-07');
  assert.deepEqual(asked, [['forDay', '2026-11-07'], ['history', '2026-11-07', 7]]);
  assert.equal(r.rows.length, 1);
  assert.equal(r.history.length, 2);
  assert.equal(r.rows[0].lastPostAt, '2026-11-07T08:00:00.000Z');
  assert.equal(r.rows[0].darkSince, null);
});

test('the default day is today in Europe/Kyiv (23:30 UTC is already tomorrow there)', async () => {
  const { c } = setup();
  c.now = () => new Date('2026-11-06T23:30:00Z');
  assert.equal((await c.get()).day, '2026-11-07');
});

test('a malformed day is a 400', async () => {
  const { c } = setup();
  await assert.rejects(() => c.get('yesterday'), BadRequestException);
  await assert.rejects(() => c.get('2026-1-7'), BadRequestException);
});
