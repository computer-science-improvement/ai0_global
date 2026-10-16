import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { buildScheduleTools, registerSlotRunActions, REPLAN_TODAY_KIND, SLOT_REGENERATE_KIND } from './schedule-tools';
import { hasScheduleChangeIntent } from './schedule-intent';
import { ScheduleService, type ScheduleScope } from './schedule.service';
import { ToolRegistry } from '../harness/tool-registry';
import { defineTool } from '../harness/tool';
import { makeCard } from '../post/testing/fixtures';

/** Spec 040 FR-013: slot control from chat — @manager and channel agents, regenerate, replan today. */

const NOW = new Date('2026-10-16T09:00:00Z');
const LOKO: any = { id: 'a-loko', handle: 'loko', kind: 'orchestrator', scope: 'resource', scopeId: 'telegram:@loko', parentId: null };
const SPACE: any = { id: 'a-space', handle: 'space', kind: 'orchestrator', scope: 'resource', scopeId: 'telegram:@space', parentId: null };
const MANAGER: any = { id: 'a-mgr', handle: 'manager', kind: 'manager', scope: 'system', scopeId: null, parentId: null };
const SLOT_ID = '6b1d1b0e-3f2a-4c55-9d8e-1a2b3c4d5e6f';

function slot(over: Record<string, unknown> = {}): any {
  return {
    id: SLOT_ID, channelKey: '@space', kind: 'content', status: 'planned', topic: 'Запуск Starship', resourceRef: 'telegram:@space',
    scheduledAt: new Date('2026-10-16T15:00:00Z'), treatment: null, ...over,
  };
}

/** The real service with the network context stubbed (scopeOf reads the playbook and the resources). */
function service(s: any = slot()) {
  const agents = [LOKO, SPACE];
  return new (class extends ScheduleService {
    async scopeOf(a: any): Promise<ScheduleScope> {
      return { agent: a, card: makeCard({ channelKey: telegramKey(a) }), net: { resources: [] } as any };
    }
  })({
    pool: {} as any, rules: {} as any, network: {} as any, inbox: {} as any, card: async () => null,
    agents: {
      getByHandle: async (h: string) => agents.find((a) => a.handle === h) ?? null,
      get: async (id: string) => agents.find((a) => a.id === id) ?? null,
      findTop: async (_k: string, _s: string, ref: string) => agents.find((a) => a.scopeId === ref) ?? null,
    } as any,
    plans: { getSlot: async (id: string) => (id === SLOT_ID ? s : null), reservedSlots: async () => [] } as any,
    now: () => NOW,
  } as any);
}
const telegramKey = (a: any) => String(a.scopeId).replace('telegram:', '');

function setup(agent: any, ownerText = 'перегенеруй вечірній пост і переплануй сьогодні', s = slot()) {
  const proposed: any[] = [];
  const schedule = service(s);
  const tools = Object.fromEntries(buildScheduleTools({ schedule, actions: { propose: async (a: any) => { proposed.push(a); return { id: `pa${proposed.length}`, ...a }; } }, now: () => NOW }).map((t) => [t.name, t]));
  const ctx: any = { runId: 'r', role: agent.kind === 'manager' ? 'manager' : 'composer', channelKey: null, extras: { chat: { chatId: 'c1', channelKey: null }, agentIntent: false, ownerText, agent } };
  return { tools, ctx, proposed, schedule };
}

test('scopeByTarget: @handle, channel key, resource ref, bare name; scopeBySlot follows the slot', async () => {
  const s = service();
  const handle = (r: any) => ('error' in r ? r.error : r.agent.handle);
  assert.equal(handle(await s.scopeByTarget('@loko')), 'loko');
  assert.equal(handle(await s.scopeByTarget('space')), 'space');
  assert.equal(handle(await s.scopeByTarget('telegram:@space')), 'space');
  assert.equal(handle(await s.scopeByTarget('telegram:space')), 'space');
  assert.equal(handle(await s.scopeByTarget('instagram:999')), 'no_agent');
  assert.equal(handle(await s.scopeBySlot(SLOT_ID)), 'space');
  assert.equal(handle(await s.scopeBySlot('00000000-0000-4000-8000-000000000000')), 'slot_not_found');
});

test('@manager proposes regenerate and replan for any resource, one card per resource', async () => {
  const { tools, ctx, proposed } = setup(MANAGER);
  const r: any = await tools.propose_slot_change.execute({ slot_id: SLOT_ID, op: 'regenerate' }, ctx);
  assert.equal(r.pending_action, 'pa1');
  assert.equal(proposed[0].kind, SLOT_REGENERATE_KIND);
  assert.deepEqual(proposed[0].payload, { agent_id: 'a-space', slot_id: SLOT_ID, channel_key: '@space' });
  assert.match(proposed[0].summary, /^Write "Запуск Starship" on telegram:@space now \(planned for 2026-10-16/);

  for (const channel of ['@loko', 'telegram:@space']) await tools.propose_replan_today.execute({ channel }, ctx);
  assert.deepEqual(proposed.slice(1).map((p) => [p.kind, p.payload.channel_key, p.agentId]), [[REPLAN_TODAY_KIND, '@loko', 'a-loko'], [REPLAN_TODAY_KIND, '@space', 'a-space']]);
  assert.match(proposed[1].summary, /^Replan the rest of today \(2026-10-16\) for @loko \(@loko\)/);

  const none: any = await tools.propose_replan_today.execute({}, ctx);
  assert.equal(none.error, 'no_channel', '@manager has no channel of its own');
});

test('a channel agent controls only its own schedule', async () => {
  const { tools, ctx, proposed } = setup(LOKO);
  const other: any = await tools.propose_replan_today.execute({ channel: '@space' }, ctx);
  assert.equal(other.error, 'out_of_scope');
  assert.match(other.details, /@space/);
  const foreignSlot: any = await tools.propose_slot_change.execute({ slot_id: SLOT_ID, op: 'regenerate' }, ctx);
  assert.equal(foreignSlot.error, 'slot_not_found', 'a slot of another channel is not found in its scope');
  const own: any = await tools.propose_replan_today.execute({}, ctx);
  assert.equal(own.pending_action, 'pa1');
  assert.equal(proposed[0].payload.channel_key, '@loko');
});

test('regenerate only a planned own slot within 48 h; a derived slot waits for its source', async () => {
  for (const [over, error] of [
    [{ status: 'published' }, 'slot_not_planned'],
    [{ kind: 'reserved' }, 'slot_not_runnable'],
    [{ treatment: 'adapt' }, 'derived_slot'],
    [{ scheduledAt: new Date('2026-10-19T09:00:00Z') }, 'slot_too_far'],
  ] as const) {
    const { tools, ctx } = setup(MANAGER, 'перегенеруй пост', slot(over));
    const r: any = await tools.propose_slot_change.execute({ slot_id: SLOT_ID, op: 'regenerate' }, ctx);
    assert.equal(r.error, error, JSON.stringify(over));
  }
});

test('the cards need the owner\'s request; replan / regenerate verbs count', async () => {
  const { tools, ctx, proposed } = setup(MANAGER, 'що там у плані?');
  assert.equal(((await tools.propose_replan_today.execute({ channel: '@loko' }, ctx)) as any).error, 'needs_explicit_request');
  assert.equal(proposed.length, 0);
  for (const t of ['перепиши вечірній пост', 'regenerate the 18:00 post', 'replan today please', 'напиши зараз пост про запуск']) assert.equal(hasScheduleChangeIntent(t), true, t);
});

test('chat-only tools are offered to a role in chat, never in its autonomous run', () => {
  const t = (name: string, chatOnly?: boolean) => defineTool({ name, description: name, kind: 'read', roles: ['manager'], chatOnly, input: z.object({}), execute: async () => ({}) });
  const reg = new ToolRegistry([t('get_schedule', true), t('kpi')]);
  assert.deepEqual(reg.forRole('manager').map((x) => x.name), ['kpi']);
  assert.deepEqual(reg.forRole('manager', null, { chat: true }).map((x) => x.name), ['get_schedule', 'kpi']);
});

test('Apply runs the editor ops: write the slot now, replan the channel', async () => {
  const handlers = new Map<string, (p: any) => Promise<unknown>>();
  const calls: any[] = [];
  registerSlotRunActions({ register: (k: string, fn: any) => { handlers.set(k, fn); } } as any, {
    runSlot: async (id, o) => { calls.push(['run', id, o]); return {}; },
    replan: async (key, o) => { calls.push(['replan', key, o]); return {}; },
  });
  assert.deepEqual(await handlers.get(SLOT_REGENERATE_KIND)!({ slot_id: SLOT_ID }), { started: true, slot: SLOT_ID });
  assert.deepEqual(await handlers.get(REPLAN_TODAY_KIND)!({ channel_key: '@loko' }), { started: true, channel: '@loko' });
  assert.deepEqual(calls, [['run', SLOT_ID, { wait: false }], ['replan', '@loko', { wait: false }]]);
});
