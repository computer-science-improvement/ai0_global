/** Spec 086 FR-002: a silent Epic host costs the Epic refinement only, never the GamerPower values. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gamerpowerAdapter } from './gamerpower.adapter';

const GP = { id: 1, title: 'Hogwarts Legacy (Epic Games) Giveaway', description: 'd', instructions: 'i', type: 'Game', platforms: 'PC, Epic Games Store',
  end_date: '2026-10-05 23:59:00', gamerpower_url: 'https://gamerpower.com/1', image: '', published_date: '2026-09-30 10:00:00', status: 'Active' };

test('an Epic read that never answers is cut off at its own budget and the GamerPower values stay', async () => {
  const ctx: any = {
    now: () => new Date('2026-10-01T00:00:00Z'),
    getJson: (url: string) => (url.includes('epicgames') ? new Promise(() => { /* the host accepts the connection and says nothing */ }) : Promise.resolve([GP])),
  };
  const t0 = Date.now();
  const r = await (gamerpowerAdapter.fetch as any)({ limit: 10 }, ctx, 50);
  assert.ok(Date.now() - t0 < 2000, 'returned long before the 30 s tool timeout');
  assert.equal(r.items.length, 1);
  assert.deepEqual([r.items[0].extra.ends_at, r.items[0].extra.ends_at_source], ['2026-10-05', 'gamerpower']);
});
