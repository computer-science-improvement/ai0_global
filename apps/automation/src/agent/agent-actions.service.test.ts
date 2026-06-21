import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentActionsService } from './agent-actions.service';

function harness(opts: { action: any; cap?: number; repliesSoFar?: number }) {
  const calls: any[] = [];
  const repo = {
    findById: async () => opts.action,
    setStatus: async (id: string, s: string, patch?: any) => { calls.push(['setStatus', id, s, patch]); },
    mergePayload: async (id: string, e: any) => { calls.push(['mergePayload', id, e]); },
    countRepliesSince: async () => opts.repliesSoFar ?? 0,
  } as any;
  const sender = { sendReply: async (...a: any[]) => { calls.push(['send', ...a]); return { ok: true }; } } as any;
  const exec = { schedule: async (p: any) => { calls.push(['schedule', p]); return 'sp1'; } } as any;
  const threads = {
    threadPeer: async () => ({ peer_id: '42', peer_username: null }),
    stampReplied: async (id: string, text: string) => { calls.push(['stamp', id, text]); },
  } as any;
  const config = { get: (k: string) => (k === 'AGENT_REPLY_DAILY_CAP' ? String(opts.cap ?? 20) : undefined) } as any;
  return { svc: new AgentActionsService(repo, sender, exec, threads, config), calls };
}

test('approve(reply) sends, marks done, stamps thread', async () => {
  const { svc, calls } = harness({ action: { id: 'a', type: 'reply', status: 'pending', thread_id: 't', payload: { text: 'hi' } } });
  const r = await svc.approve('a');
  assert.equal(r.status, 'done');
  assert.ok(calls.some(c => c[0] === 'send'));
  assert.ok(calls.some(c => c[0] === 'setStatus' && c[2] === 'done'));
});

test('approve(reply) over the daily cap is rejected, sender NOT called', async () => {
  const { svc, calls } = harness({ action: { id: 'a', type: 'reply', status: 'pending', thread_id: 't', payload: { text: 'hi' } }, cap: 2, repliesSoFar: 2 });
  const r = await svc.approve('a');
  assert.equal(r.status, 'failed');
  assert.match(r.error ?? '', /cap/i);
  assert.ok(!calls.some(c => c[0] === 'send'));
});

test('approve(schedule_post) schedules + stores scheduled id', async () => {
  const { svc, calls } = harness({ action: { id: 'a', type: 'schedule_post', status: 'pending', thread_id: null, payload: { text: 'Ad', channelId: 'c1', scheduledAt: '2030-01-01T00:00:00Z' } } });
  const r = await svc.approve('a');
  assert.equal(r.status, 'done');
  assert.ok(calls.some(c => c[0] === 'schedule'));
  assert.ok(calls.some(c => c[0] === 'mergePayload'));
});

test('approve on a non-pending action is a no-op', async () => {
  const { svc, calls } = harness({ action: { id: 'a', type: 'reply', status: 'done', thread_id: 't', payload: { text: 'hi' } } });
  const r = await svc.approve('a');
  assert.equal(r.status, 'done');
  assert.ok(!calls.some(c => c[0] === 'send'));
});

test('reject marks rejected', async () => {
  const { svc, calls } = harness({ action: { id: 'a', type: 'reply', status: 'pending', thread_id: 't', payload: { text: 'hi' } } });
  const r = await svc.reject('a');
  assert.equal(r.status, 'rejected');
  assert.ok(calls.some(c => c[0] === 'setStatus' && c[2] === 'rejected'));
});
