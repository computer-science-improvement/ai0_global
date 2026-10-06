import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { EditorOpsService, EditorOpsDeps } from './editor-ops.service';
import { makeCard } from '../post/testing/fixtures';
import type { EditorCard } from '../card';
import type { EditorSlot } from '../repo/editor-plans.repository';
import { defineTool } from '../harness/tool';

const NOW = new Date('2026-10-01T09:00:00Z'); // 12:00 Kyiv

const slot = (over: Partial<EditorSlot> = {}): EditorSlot => ({
  id: 's1', planId: 'p1', channelKey: '@chan', scheduledAt: new Date('2026-10-01T15:00:00Z'), kind: 'content',
  format: 'text', topic: 'тема', angle: null, sourceHints: [], isExperiment: false, status: 'planned', attempts: 0,
  runId: null, publishedPostId: null, postSpec: null, renderedPreview: null, error: null, ...over,
});

function setup(over: { cards?: EditorCard[]; slots?: EditorSlot[]; enabled?: boolean } = {}) {
  const cards = new Map((over.cards ?? [makeCard()]).map((c) => [c.channelKey, c]));
  const slots = new Map((over.slots ?? [slot()]).map((s) => [s.id, s]));
  const calls: string[] = [];
  const memory: any[] = [];
  const readTool = defineTool({
    name: 'get_channel_card', description: 'card', kind: 'read', roles: ['planner', 'executor'],
    input: z.object({}), execute: async (_i, ctx) => ({ channel: (ctx.extras!.card as EditorCard).channelKey, role: ctx.role }),
  });
  const lintTool = defineTool({
    name: 'lint_post', description: 'lint', kind: 'read', roles: ['executor'],
    input: z.object({ text: z.string().min(2) }), execute: async ({ text }) => ({ ok: text.length > 3 }),
  });
  const actTool = defineTool({
    name: 'publish_post', description: 'publish', kind: 'terminal', roles: ['executor'],
    input: z.object({}), execute: async () => { calls.push('PUBLISHED'); return { ok: true }; },
  });
  const tools = [readTool, lintTool, actTool];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const d: EditorOpsDeps = {
    channels: {
      get: async (k) => (cards.has(k) ? { ...cards.get(k)!, createdAt: NOW } : null),
      list: async () => [...cards.values()].map((c) => ({ ...c, createdAt: NOW })),
      upsert: async (c) => {
        const previousMode = cards.get(c.channelKey)?.mode ?? null;
        cards.set(c.channelKey, c);
        calls.push(`upsert:${c.channelKey}:${c.mode}`);
        return { card: { ...c, createdAt: NOW }, previousMode };
      },
    },
    plans: {
      listPlans: async (date, ch) => { calls.push(`plans:${date}:${ch ?? '*'}`); return []; },
      slotStatusCounts: async () => [
        { channelKey: '@chan', planDate: '2026-10-01', status: 'planned', n: 2 },
        { channelKey: '@chan', planDate: '2026-10-01', status: 'shadowed', n: 1 },
        { channelKey: '@chan', planDate: '2026-09-30', status: 'failed', n: 9 },
      ],
      getSlot: async (id) => slots.get(id) ?? null,
      claimSlot: async (id) => {
        const s = slots.get(id);
        if (!s || s.status !== 'planned') return null;
        const next = { ...s, status: 'running' as const, attempts: s.attempts + 1 };
        slots.set(id, next);
        calls.push(`claim:${id}`);
        return next;
      },
      skipPlannedSlot: async (id, reason) => {
        const s = slots.get(id);
        if (!s || s.status !== 'planned') return null;
        const next = { ...s, status: 'skipped' as const, error: reason };
        slots.set(id, next);
        return next;
      },
    },
    memory: {
      listAll: async () => memory,
      add: async (k, kind, text, ev, by) => { memory.push({ k, kind, text, ev, by }); return memory.length; },
      retireByOwner: async (_k, id) => id === 1,
    },
    runs: {
      list: async (f) => { calls.push(`runs:${f.channelKey ?? '*'}:${f.limit}`); return []; },
      get: async (id) => (id === 'r1' ? { run: { id: 'r1' } as any, steps: [] } : null),
      spendByDay: async (days) => [
        { day: '2026-10-01', channelKey: '@chan', usd: 0.012, runs: 3 },
        { day: '2026-10-01', channelKey: null, usd: 0.001, runs: 1 },
        ...(days > 1 ? [{ day: '2026-09-30', channelKey: '@chan', usd: 0.5, runs: 9 }] : []),
      ],
    },
    runner: {
      runPlanner: async (card) => { calls.push(`planner:${card.channelKey}`); await gate; return { runId: 'rp', status: 'ok', terminalTool: 'submit_plan', totals: {} as any }; },
      runExecutor: async (s, card) => { calls.push(`executor:${s.id}:${s.status}:${card.mode}`); return { runId: 'rx', status: 'ok', terminalTool: 'publish_post', totals: {} as any }; },
    },
    registry: { all: () => tools, get: (n) => tools.find((t) => t.name === n) },
    skills: { list: () => [{ name: 'channel-space' }] },
    enabled: () => over.enabled ?? true,
    now: () => NOW,
  };
  return { svc: new EditorOpsService(d), calls, slots, cards, memory, release };
}

test('listChannels: cards with today (local) slot counts and today (Kyiv) spend', async () => {
  const { svc } = setup();
  const r = await svc.listChannels();
  assert.equal(r.enabled, true);
  assert.equal(r.channels.length, 1);
  assert.deepEqual(r.channels[0].today, { date: '2026-10-01', spendUsd: 0.012, runs: 3, slots: { planned: 2, shadowed: 1 } });
  assert.equal(r.channels[0].channelKey, '@chan');
});

test('getChannel: 404 for an unknown key', async () => {
  const { svc } = setup();
  await assert.rejects(svc.getChannel('@nope'), NotFoundException);
});

test('upsertChannel: validates, rejects unknown skills/tools, creates and updates', async () => {
  const { svc, calls } = setup();
  await assert.rejects(svc.upsertChannel('@chan', { postsPerDayMin: 9, postsPerDayMax: 2 }), BadRequestException);
  await assert.rejects(svc.upsertChannel('@chan', { skills: ['nope'] }), BadRequestException);
  await assert.rejects(svc.upsertChannel('@chan', { toolsAllow: ['rm_rf'] }), BadRequestException);
  await assert.rejects(svc.upsertChannel('', { mode: 'off' }), BadRequestException);
  const r = await svc.upsertChannel('@chan', { mode: 'live', skills: ['channel-space'], toolsAllow: ['lint_post'] });
  assert.equal(r.card.mode, 'live');
  assert.equal(r.previousMode, 'shadow');
  const created = await svc.upsertChannel('@new', { brief: 'новий' });
  assert.equal(created.previousMode, null);
  assert.equal(created.card.mode, 'approve', 'spec 031: a new resource starts in approval mode');
  assert.deepEqual(calls.filter((c) => c.startsWith('upsert')), ['upsert:@chan:live', 'upsert:@new:approve']);
});

test('listPlans: defaults to today in Kyiv, validates the date', async () => {
  const { svc, calls } = setup();
  await svc.listPlans(undefined, '@chan');
  await svc.listPlans('2026-09-30');
  await assert.rejects(svc.listPlans('30.09.2026'), BadRequestException);
  assert.deepEqual(calls, ['plans:2026-10-01:@chan', 'plans:2026-09-30:*']);
});

test('runSlot: claims first, then goes through the normal executor', async () => {
  const { svc, calls, slots } = setup();
  const r = await svc.runSlot('s1', { wait: true });
  assert.deepEqual(calls, ['claim:s1', 'executor:s1:running:shadow']);
  assert.equal(r.started, true);
  assert.equal(r.result!.status, 'ok');
  assert.equal(slots.get('s1')!.attempts, 1);
  await assert.rejects(svc.runSlot('s1', { wait: true }), ConflictException, 'second run: slot is no longer planned');
});

test('runSlot: refuses when the editor is disabled, the channel is off, or the slot is unknown — without claiming', async () => {
  const disabled = setup({ enabled: false });
  await assert.rejects(disabled.svc.runSlot('s1', { wait: true }), ServiceUnavailableException);
  assert.deepEqual(disabled.calls, []);

  const off = setup({ cards: [makeCard({ mode: 'off' })] });
  await assert.rejects(off.svc.runSlot('s1', { wait: true }), ConflictException);
  assert.deepEqual(off.calls, []);

  const reserved = setup({ slots: [slot({ kind: 'reserved' })] });
  await assert.rejects(reserved.svc.runSlot('s1', { wait: true }), ConflictException);

  const missing = setup();
  await assert.rejects(missing.svc.runSlot('nope', { wait: true }), NotFoundException);
});

test('runSlot without wait: returns right after the claim', async () => {
  const { svc, calls } = setup();
  const r = await svc.runSlot('s1', { wait: false });
  assert.deepEqual(r, { started: true, slotId: 's1' });
  assert.equal(calls[0], 'claim:s1');
});

test('skipSlot: only planned slots', async () => {
  const { svc } = setup({ slots: [slot(), slot({ id: 's2', status: 'running' })] });
  const r = await svc.skipSlot('s1', 'не актуально');
  assert.equal(r.status, 'skipped');
  assert.equal(r.error, 'skipped by owner: не актуально');
  await assert.rejects(svc.skipSlot('s2'), ConflictException);
  await assert.rejects(svc.skipSlot('zz'), NotFoundException);
});

test('replan: runs the planner; refuses concurrent replans, disabled editor and off channels', async () => {
  const { svc, calls, release } = setup();
  const first = svc.replan('@chan', { wait: true });
  await assert.rejects(svc.replan('@chan', { wait: true }), ConflictException);
  release();
  const r = await first;
  assert.equal(r.result!.terminalTool, 'submit_plan');
  assert.deepEqual(calls, ['planner:@chan']);

  await assert.rejects(setup({ enabled: false }).svc.replan('@chan', {}), ServiceUnavailableException);
  await assert.rejects(setup({ cards: [makeCard({ mode: 'off' })] }).svc.replan('@chan', {}), ConflictException);
  await assert.rejects(setup().svc.replan('@nope', {}), NotFoundException);
});

test('memory: owner entries only; retire 404s when nothing changed', async () => {
  const { svc, memory } = setup();
  await svc.addMemory('@chan', { kind: 'rule', text: 'Завжди посилання на джерело' });
  assert.deepEqual(memory[0], { k: '@chan', kind: 'rule', text: 'Завжди посилання на джерело', ev: null, by: 'owner' });
  await assert.rejects(svc.addMemory('@chan', { kind: 'secret', text: 'x' }), BadRequestException);
  await assert.rejects(svc.addMemory('@chan', { kind: 'rule', text: 'ok', createdBy: 'reviewer' }), BadRequestException);
  await assert.rejects(svc.addMemory('@nope', { kind: 'rule', text: 'текст' }), NotFoundException);
  assert.deepEqual(await svc.retireMemory('@chan', 1), { ok: true });
  await assert.rejects(svc.retireMemory('@chan', 2), NotFoundException);
});

test('runs and spend: limits are clamped, unknown run 404s', async () => {
  const { svc, calls } = setup();
  await svc.listRuns({ channel: '@chan', limit: '5000' });
  await svc.listRuns({});
  assert.deepEqual(calls, ['runs:@chan:200', 'runs:*:50']);
  await assert.rejects(svc.getRun('r2'), NotFoundException);
  const s = await svc.spend('30');
  assert.equal(s.days, 30);
  assert.equal(s.rows.length, 3);
  assert.equal(s.totalUsd, 0.513);
  await assert.rejects(svc.spend('0'), BadRequestException);
});

test('tools: only read tools are listed and callable, with the channel card in context', async () => {
  const { svc, calls } = setup();
  const list = svc.listTools();
  assert.deepEqual(list.map((t) => t.name), ['get_channel_card', 'lint_post']);
  assert.equal((list[1].parameters as any).type, 'object');

  assert.deepEqual(await svc.callTool('get_channel_card', { channel: '@chan', input: {} }), { result: { channel: '@chan', role: 'executor' } });
  assert.deepEqual(await svc.callTool('get_channel_card', { channel: '@chan', role: 'planner' }), { result: { channel: '@chan', role: 'planner' } });
  const bad = await svc.callTool('lint_post', { channel: '@chan', input: { text: 1 } });
  assert.equal((bad.result as any).error, 'invalid_arguments');
  await assert.rejects(svc.callTool('publish_post', { channel: '@chan', input: {} }), NotFoundException);
  await assert.rejects(svc.callTool('get_channel_card', { channel: '@nope' }), NotFoundException);
  assert.ok(!calls.includes('PUBLISHED'));
});
