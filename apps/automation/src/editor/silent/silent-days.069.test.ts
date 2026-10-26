// Spec 069 A8 on fakes: a past day is reported once (yesterday is not told again as the 48 h window slides), a first miss
// that is found late still goes out — as a standalone note that answers nothing — and the watch reads the reported days
// from the Inbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCard } from '../post/testing/fixtures';
import { evaluateSilentDays, SilentDaysWatch, type WatchSlot } from './silent-days';

const TZ = 'Europe/Kyiv'; // UTC+3 in October
const at = (iso: string) => new Date(iso);
const REF = 'telegram:@birzha';
const RES = [{ ref: REF, tz: TZ, minPerDay: 0 }];

function slot(o: Partial<WatchSlot> & { id: string; scheduledAt: Date }): WatchSlot {
  return {
    ref: REF, updatedAt: o.scheduledAt, status: 'skipped', error: 'no_fresh_item: x', format: 'text', topic: 'Тема', seriesName: 'Prompt', scheduleRuleId: null,
    criticVerdict: null, fallback: null, ...o,
  };
}

test('a past day that was already reported is not reported again; today and a late first miss still are', () => {
  const miss = [
    slot({ id: 'y', scheduledAt: at('2026-10-21T06:00:00Z') }), // yesterday (Kyiv)
    slot({ id: 't', scheduledAt: at('2026-10-22T06:00:00Z') }), // today
  ];
  const now = at('2026-10-22T07:30:00Z');
  const none = evaluateSilentDays({ now, resources: RES, slots: miss });
  assert.deepEqual(none.map((a) => a.day).sort(), ['2026-10-21', '2026-10-22'], 'without the reported set both days come out (the old behaviour)');

  const told = evaluateSilentDays({ now, resources: RES, slots: miss, reportedDays: new Set([`${REF}|2026-10-21`]) });
  assert.deepEqual(told.map((a) => a.day), ['2026-10-22'], 'yesterday was told: only today is evaluated');
  assert.equal(told[0].pastDay, undefined, 'today is an ordinary note');

  // Today's own day in the set changes nothing (the gate, not the set, decides about today).
  const todayToo = evaluateSilentDays({ now, resources: RES, slots: miss, reportedDays: new Set([`${REF}|2026-10-22`]) });
  assert.deepEqual(todayToo.map((a) => a.day).sort(), ['2026-10-21', '2026-10-22']);

  // A first miss found after midnight: not in the set, so it goes out, marked as a past day.
  const late = evaluateSilentDays({ now, resources: RES, slots: [miss[0]], reportedDays: new Set([`${REF}|2026-10-20`]) });
  assert.equal(late.length, 1);
  assert.equal(late[0].day, '2026-10-21');
  assert.equal(late[0].pastDay, true);

  // Another resource's reported day is not this one's.
  const other = evaluateSilentDays({ now, resources: RES, slots: [miss[0]], reportedDays: new Set(['telegram:@other|2026-10-21']) });
  assert.equal(other.length, 1);
});

function fakeWorld(o: { reported?: string[]; reportedThrows?: boolean; slots: () => WatchSlot[] }) {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      if (/FROM editor_slots/.test(sql)) {
        return { rows: o.slots().map((s) => ({
          id: s.id, ref: s.ref, channel_key: s.ref.replace(/^telegram:/, ''), scheduled_at: s.scheduledAt, updated_at: s.updatedAt, status: s.status,
          error: s.error, format: s.format, topic: s.topic, series_name: s.seriesName, schedule_rule_id: s.scheduleRuleId, verdict: s.criticVerdict, fallback: s.fallback,
        })) };
      }
      if (/resource_tz/.test(sql)) return { rows: [{ ref: REF, tz: TZ }] };
      if (/FROM agents/.test(sql)) return { rows: [{ scope_id: REF, id: 'orch-1' }] };
      if (/FROM agent_inbox/.test(sql)) {
        queries.push(sql);
        if (o.reportedThrows) throw new Error('relation "agent_inbox" does not exist');
        return { rows: (o.reported ?? []).map((day_ref) => ({ day_ref })) };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const items: any[] = [];
  const inbox = { items, postOnce: async (i: any) => { items.push(i); return items.length; } };
  return { pool, queries, inbox, items };
}

test('the watch reads the reported days from the Inbox and posts a late past-day miss as a standalone note', async () => {
  const data = [slot({ id: 'y', scheduledAt: at('2026-10-21T06:00:00Z') }), slot({ id: 't', scheduledAt: at('2026-10-22T06:00:00Z') })];
  const w = fakeWorld({ reported: [`${REF}|2026-10-21`], slots: () => data });
  const watch = new SilentDaysWatch({ pool: w.pool as any, inbox: w.inbox, everyMs: 0 });
  const cards = [makeCard({ channelKey: '@birzha', mode: 'live', postsPerDayMin: 0 })];
  await watch.check(cards, at('2026-10-22T07:30:00Z'));
  assert.deepEqual(w.items.map((i) => i.refId), [`${REF}|2026-10-22`]);
  assert.equal(w.items[0].gate.standalone, undefined);
  assert.match(w.queries[0], /resource_day/);
  assert.match(w.queries[0], /series_missed/);

  const w2 = fakeWorld({ reported: [], slots: () => [data[0]] });
  await new SilentDaysWatch({ pool: w2.pool as any, inbox: w2.inbox, everyMs: 0 }).check(cards, at('2026-10-22T07:30:00Z'));
  assert.equal(w2.items.length, 1);
  assert.equal(w2.items[0].refId, `${REF}|2026-10-21`);
  assert.equal(w2.items[0].gate.standalone, true, 'a note about a past day answers nothing');
  assert.equal(w2.items[0].gate.subject, `silent:${REF}:miss`, 'the gate memory is still shared with the other days');
});

test('a failed reported-days lookup is an empty set: the gate still decides', async () => {
  const data = [slot({ id: 'y', scheduledAt: at('2026-10-21T06:00:00Z') })];
  const w = fakeWorld({ reportedThrows: true, slots: () => data });
  const watch = new SilentDaysWatch({ pool: w.pool as any, inbox: w.inbox, everyMs: 0 });
  const n = await watch.check([makeCard({ channelKey: '@birzha', mode: 'live', postsPerDayMin: 0 })], at('2026-10-22T07:30:00Z'));
  assert.equal(n, 1);
});

test('a planner placeholder skip in several series of one day is one gated note, not one per series', async () => {
  // Spec 068 records a slot the planner could not fill as status skipped with its own error text; to this watch it is a miss
  // like any other: one note per resource and day listing them, with the series and the reason as its parts.
  const data = [
    slot({ id: 'a', scheduledAt: at('2026-10-22T05:00:00Z'), seriesName: 'Prompt', error: 'planner_no_material: no usable row in the dataset' }),
    slot({ id: 'b', scheduledAt: at('2026-10-22T06:00:00Z'), seriesName: 'Recipe', error: 'planner_no_material: no usable row in the dataset' }),
  ];
  const alerts = evaluateSilentDays({ now: at('2026-10-22T09:00:00Z'), resources: RES, slots: data });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'series_missed');
  assert.equal(alerts[0].parts.length, 2);
  assert.ok(alerts[0].parts.every((p) => p.startsWith('missed:')));

  const w = fakeWorld({ slots: () => data });
  const watch = new SilentDaysWatch({ pool: w.pool as any, inbox: w.inbox, everyMs: 0 });
  await watch.check([makeCard({ channelKey: '@birzha', mode: 'live', postsPerDayMin: 0 })], at('2026-10-22T09:00:00Z'));
  assert.equal(w.items.length, 1);
  assert.deepEqual(w.items[0].gate.parts, alerts[0].parts);
});
