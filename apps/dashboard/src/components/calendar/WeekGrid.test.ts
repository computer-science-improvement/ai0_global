// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 078 B4.1: the grid parts of the Calendar render (server-side, no browser): the row heads, the chips with their links
// and marks, the Add buttons, a row whose schedule did not load, and the phone agenda. The clicks and the layout are checked by
// hand in the browser (tasks.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { CalLegend, DayAgenda, WeekGrid, scheduleErrorText } from './WeekGrid';
import { buildRows, windowDays, type CalAgent, type CalRow } from '../../lib/calendar';

const TODAY = '2026-10-29';
const DAYS = windowDays(TODAY);
const NOW = '2026-10-29T09:00:00Z';

const agent = (over: Partial<CalAgent> = {}): CalAgent => ({
  handle: 'space', name: 'Space', emoji: '🚀', mode: 'live', paused: false, channelKey: '@space', ref: 'telegram:@space', ...over,
});

const slot = (over: Record<string, unknown> = {}): any => ({
  id: 's1', resourceRef: 'telegram:@space', at: '2026-10-29T08:00:00Z', date: TODAY, time: '10:00', kind: 'content', status: 'published',
  format: 'text', topic: 'Webb telescope news', seriesName: null, scheduleRuleId: null, promo: false, error: null, ...over,
});

const schedule = (slots: any[], items: any[] = []): any => ({
  agent: { id: 'a', handle: 'space' }, anchor: '@space', mode: 'live', now: NOW, from: TODAY, to: DAYS[6] ?? TODAY, days: DAYS,
  resources: [{ ref: 'telegram:@space', platform: 'telegram', timezone: 'Europe/Kyiv', formats: ['text'] }], series: [], rules: [], items, slots,
});

const post = (over: Record<string, unknown> = {}): any => ({
  id: 'p1', channelId: 'c1', sender: 'bot', botId: 'b1', text: '<b>Hello</b> readers', mediaType: 'none', mediaUrl: null, mediaPlacement: 'above',
  buttons: [], scheduledAt: '2026-10-30T10:00:00.000Z', status: 'pending', messageId: null, error: null, createdAt: NOW, updatedAt: NOW, ...over,
});

const channel = (over: Record<string, unknown> = {}): any => ({ id: 'c1', channelKey: '@space', title: 'Space', username: 'space', isMine: true, ...over });

async function mount(node: () => ReturnType<typeof h>): Promise<string> {
  const root = createRootRoute({ component: node as any });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToString(h(RouterProvider, { router }));
}

const noop = () => {};
const grid = (rows: CalRow[]) => h(WeekGrid, { rows, days: DAYS, today: TODAY, onAdd: noop, onOpenPost: noop });

test('the grid: a row head per agent, chips with their links and Add buttons on today and later days only', async () => {
  const rows = buildRows({
    agents: [agent()], schedules: { space: { data: schedule([slot(), slot({ id: 's2', time: '11:30', status: 'planned', topic: 'Second' })]) } }, pauses: {},
    channels: [channel()], posts: [post()], days: DAYS, today: TODAY,
  });
  const html = await mount(() => grid(rows));
  assert.match(html, /role="table"/);
  assert.match(html, /aria-label="Calendar, agents by day"/);
  assert.match(html, /href="\/app\/agents\/space"[^>]*>Space</);
  assert.match(html, /@space/);
  assert.match(html, /href="\/app\/editor\/slot\/s1"/);
  assert.match(html, /href="\/app\/editor\/slot\/s2"/);
  assert.match(html, /Webb telescope news/);
  assert.match(html, /aria-label="Add post to Space on Thu, 29 Oct"/);
  assert.match(html, /aria-label="Add post to Space on Mon, 2 Nov"/);
  assert.match(html, /aria-current="date"/);
  // the owner's post is a button, not a link
  assert.match(html, /<button[^>]*class="cal-chip is-yours[^"]*"[^>]*>/);
  assert.match(html, /Yours · scheduled/);
});

test('the grid: past days take no Add button; a row whose schedule failed says so and still takes owner posts', async () => {
  const rows = buildRows({
    agents: [agent()], schedules: { space: { error: 'no_channel_card' } }, pauses: {},
    channels: [channel()], posts: [post()], days: DAYS, today: '2026-10-31',
  });
  const html = await mount(() => h(WeekGrid, { rows, days: DAYS, today: '2026-10-31', onAdd: noop, onOpenPost: noop }));
  assert.doesNotMatch(html, /Add post to Space on Thu, 29 Oct/);
  assert.doesNotMatch(html, /Add post to Space on Fri, 30 Oct/);
  assert.match(html, /Add post to Space on Sat, 31 Oct/);
  assert.match(html, /Schedule unavailable/);
  assert.match(html, /Hello readers/);
  assert.match(scheduleErrorText('no_channel_card'), /no channel card/);
  assert.match(scheduleErrorText(null), /did not load/);
});

test('the grid: an "Other channels" row, and a cell with many chips folds into "+N more"', async () => {
  const many = Array.from({ length: 7 }, (_, i) => slot({ id: `m${i}`, time: `${String(8 + i).padStart(2, '0')}:00`, topic: `Item ${i}` }));
  const rows = buildRows({
    agents: [agent()], schedules: { space: { data: schedule(many) } }, pauses: {},
    channels: [channel(), channel({ id: 'c2', channelKey: '@solo', title: 'Solo' })], posts: [], days: DAYS, today: TODAY,
  });
  assert.deepEqual(rows.map((r) => r.name), ['Space', 'Other channels']);
  const html = await mount(() => grid(rows));
  assert.match(html, /Other channels/);
  assert.match(html, /\+2 more/);
  assert.match(html, /Add post to Other channels on Thu, 29 Oct/);
});

test('the phone agenda: a panel per day with the same chips and Add buttons', async () => {
  const rows = buildRows({
    agents: [agent()], schedules: { space: { data: schedule([slot()]) } }, pauses: {},
    channels: [channel()], posts: [], days: DAYS, today: TODAY,
  });
  const html = await mount(() => h(DayAgenda, { rows, days: DAYS, today: TODAY, onAdd: noop, onOpenPost: noop }));
  assert.match(html, /aria-label="Calendar by day"/);
  assert.match(html, /Thu, 29 Oct/);
  assert.match(html, /Today/);
  assert.match(html, /Fri, 30 Oct/);
  assert.match(html, /href="\/app\/editor\/slot\/s1"/);
  assert.match(html, /aria-label="Add post to Space on Fri, 30 Oct"/);
});

test('the legend names every mark a chip can carry', async () => {
  const html = await mount(() => h(CalLegend));
  for (const t of ['Published', 'Planned by the agent', 'Awaiting your approval', 'Series, not planned yet', 'Missed', 'Skipped or paused', 'Failed', 'Your post']) {
    assert.ok(html.includes(t), t);
  }
});
