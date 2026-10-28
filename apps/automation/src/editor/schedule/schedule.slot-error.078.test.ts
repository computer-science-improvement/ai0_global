// Spec 078 B4: the schedule view tells the dashboard why a slot was skipped or failed (`error`), so the Calendar can draw a
// miss differently from a deliberate skip. Stubs only: no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScheduleService } from './schedule.service';

const TG = 'telegram:@space';
const slotRow = (over: Record<string, unknown>): any => ({
  id: 's1', channelKey: '@space', resourceRef: TG, scheduledAt: new Date('2030-01-15T10:00:00Z'), kind: 'content', status: 'published',
  format: 'text', topic: 'A topic', seriesName: null, scheduleRuleId: null, promo: null, error: null, ...over,
});

function service(rows: any[]) {
  return new ScheduleService({
    pool: { query: async () => ({ rows: [] }) } as any,
    rules: { list: async () => [], slotsBetween: async () => rows } as any,
    now: () => new Date('2030-01-15T09:00:00Z'),
  } as any);
}

const scope: any = {
  agent: { id: 'a1', handle: 'space' },
  card: { channelKey: '@space', timezone: 'Europe/Kyiv', quietStartHour: 23, quietEndHour: 8, minGapMinutes: 30, postsPerDayMin: 1, postsPerDayMax: 3, planHour: 6, mode: 'live', sources: [] },
  net: { resources: [{ ref: TG, platform: 'telegram' }], telegramFormats: ['text'], playbook: null, mode: 'live', playbookVersion: null },
};

test('the schedule view carries each slot\'s error, or null', async () => {
  const view: any = await service([
    slotRow({ id: 's1' }),
    slotRow({ id: 's2', status: 'skipped', scheduledAt: new Date('2030-01-15T11:00:00Z'), seriesName: 'Daily fact', error: 'series_source_empty: no unused rows left' }),
    slotRow({ id: 's3', status: 'failed', scheduledAt: new Date('2030-01-15T12:00:00Z'), error: undefined }),
  ]).schedule(scope, { from: '2030-01-15', to: '2030-01-15' });
  assert.deepEqual(view.slots.map((s: any) => [s.id, s.error]), [['s1', null], ['s2', 'series_source_empty: no unused rows left'], ['s3', null]]);
});
