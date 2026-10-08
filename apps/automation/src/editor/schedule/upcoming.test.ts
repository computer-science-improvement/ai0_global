import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upcomingSlots } from './upcoming';

const NOW = new Date('2030-01-15T10:00:00Z');
const agent = (handle: string, over: any = {}) => ({ id: handle, handle, kind: 'orchestrator', scope: 'resource', scopeId: `telegram:@${handle}`, parentId: null, mode: 'shadow', ...over });

function fakeSchedule(byHandle: Record<string, { items: any[]; slots: any[] }>) {
  const calls: any[] = [];
  return {
    calls,
    svc: {
      scopeOf: async (a: any) => ({ agent: a, card: { channelKey: `@${a.handle}`, timezone: 'Europe/Kyiv' }, net: {} }),
      schedule: async (sc: any, o: any) => { calls.push(o); return byHandle[sc.agent.handle]; },
    } as any,
  };
}

test('series instances and pins of every live-ish agent in the window, with the realising slot status, sorted and limited', async () => {
  const { svc, calls } = fakeSchedule({
    food: {
      items: [
        { kind: 'series', resourceRef: 'telegram:@food', date: '2030-01-15', time: '19:00', at: '2030-01-15T17:00:00Z', name: 'Рецепт дня', format: 'photo', locked: false, origin: 'migration' },
        { kind: 'series', resourceRef: 'telegram:@food', date: '2030-01-15', time: '08:00', at: '2030-01-15T06:00:00Z', name: 'Ранок', format: 'text', locked: false, origin: 'agent' }, // past
        { kind: 'pin', ruleId: 'r1', resourceRef: 'telegram:@food', date: '2030-01-15', time: '13:00', at: '2030-01-15T11:00:00Z', format: 'photo', seriesName: null, brief: 'Анонс' },
        { kind: 'blackout', ruleId: 'r2', resourceRef: 'telegram:@food', date: '2030-01-15', time: '22:00', until: '23:00' },
        { kind: 'series', resourceRef: 'telegram:@food', date: '2030-01-17', time: '19:00', at: '2030-01-17T17:00:00Z', name: 'Рецепт дня', format: 'photo', locked: false, origin: 'migration' }, // beyond 24 h
      ],
      slots: [
        { id: 's1', resourceRef: 'telegram:@food', at: '2030-01-15T17:20:00Z', date: '2030-01-15', seriesName: 'Рецепт дня', scheduleRuleId: null, status: 'planned' },
        { id: 's2', resourceRef: 'telegram:@food', at: '2030-01-15T11:00:00Z', date: '2030-01-15', seriesName: null, scheduleRuleId: 'r1', status: 'awaiting_approval' },
      ],
    },
    news: {
      items: [{ kind: 'series', resourceRef: 'telegram:@news', date: '2030-01-15', time: '15:00', at: '2030-01-15T13:00:00Z', name: 'Digest', format: 'text', locked: true, origin: 'owner' }],
      slots: [],
    },
  });
  const r = await upcomingSlots({
    schedule: svc, now: () => NOW,
    agents: { list: async () => [agent('food'), agent('news'), agent('off', { mode: 'off' }), agent('kid', { parentId: 'food', kind: 'planner' }), agent('ig', { scopeId: 'instagram:1' })] as any },
  }, { hours: 24 });
  assert.deepEqual(r.items.map((i) => [i.at, i.kind, i.name, i.agent, i.owner, i.status]), [
    ['2030-01-15T11:00:00Z', 'pin', 'Анонс', 'food', true, 'awaiting_approval'],
    ['2030-01-15T13:00:00Z', 'series', 'Digest', 'news', true, null],
    ['2030-01-15T17:00:00Z', 'series', 'Рецепт дня', 'food', false, 'planned'],
  ]);
  assert.equal(calls.length, 2, 'off agents, role children and non-Telegram scopes are skipped');
  assert.deepEqual(calls[0], { from: '2030-01-15', to: '2030-01-17' });
  const one = await upcomingSlots({ schedule: svc, now: () => NOW, agents: { list: async () => [agent('food')] as any } }, { hours: 24, limit: 1 });
  assert.equal(one.items.length, 1);
});
