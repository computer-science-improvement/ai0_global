import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScheduledPostsService } from './scheduled-posts.service';
import { ScheduledPostsRepository } from './scheduled-posts.repository';

function post(over: Record<string, unknown> = {}) {
  return {
    id: 'p1', channelId: 'ch-uuid', sender: 'bot', botId: 'bot-1',
    text: '<b>Анонс</b> вебінару\nдругий рядок', mediaType: 'none', mediaUrl: null,
    mediaPlacement: 'above', buttons: [], scheduledAt: new Date().toISOString(),
    status: 'sending', messageId: null, error: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...over,
  };
}

function build(opts: { stale?: any[]; due?: any[]; send?: () => Promise<number> } = {}) {
  const calls = {
    alerts: [] as string[], inserts: [] as any[], sent: [] as any[], failed: [] as any[],
    sends: 0, repended: 0,
  };
  const due = [...(opts.due ?? [])];
  const repo = {
    markStaleUnknown: async () => opts.stale ?? [],
    rependStale: async () => { calls.repended++; return 0; },
    claimDue: async () => due.shift() ?? null,
    markSent: async (id: string, mid: number) => { calls.sent.push([id, mid]); },
    markFailed: async (id: string, e: string) => { calls.failed.push([id, e]); },
  };
  const svc = new ScheduledPostsService(
    repo as any,
    {
      getChannelById: () => ({ id: 'ch-uuid', channel_key: '@pub', tg_chat_id: '-100', publish_paused: false }),
      getBotById: () => ({ id: 'bot-1', token_enc: null, token_env: 'BOT_TOKEN' }),
    } as any,
    { get: () => 'TOKEN' } as any,
    { send: opts.send ?? (async () => { calls.sends++; return 55; }) } as any,
    { resolveToken: (_o: any, get: any) => get('BOT_TOKEN') } as any,
    { notifyAlert: async (t: string) => { calls.alerts.push(t); } } as any,
    { insert: async (i: any) => { calls.inserts.push(i); } } as any,
  );
  return { svc, calls };
}

test('rows stuck in "sending" are marked unknown and alerted — never re-sent', async () => {
  const { svc, calls } = build({ stale: [post({ id: 'stuck-1' })] });
  await svc.publishDue();
  assert.equal(calls.repended, 0, 'must not flip stuck rows back to pending');
  assert.equal(calls.sends, 0, 'must not resend a possibly-delivered post');
  assert.equal(calls.alerts.length, 1);
  assert.match(calls.alerts[0], /stuck-1/);
  assert.match(calls.alerts[0], /unknown/);
});

test('a sent scheduled post is recorded in published_posts (channel_key, strategy type, title)', async () => {
  const { svc, calls } = build({ due: [post()] });
  await svc.publishDue();
  assert.deepEqual(calls.sent, [['p1', 55]]);
  assert.equal(calls.inserts.length, 1);
  assert.deepEqual(calls.inserts[0], {
    channelId: '@pub', messageId: 55, sourceUrl: null,
    title: 'Анонс вебінару', strategyType: 'scheduled-post', tags: null,
  });
});

test('a failed send is not recorded in published_posts', async () => {
  const { svc, calls } = build({ due: [post()], send: async () => { throw new Error('Bad Request'); } });
  await svc.publishDue();
  assert.equal(calls.inserts.length, 0);
  assert.equal(calls.failed.length, 1);
});

test('repository.markStaleUnknown flips stale "sending" rows to "unknown" (not pending)', async () => {
  const queries: string[] = [];
  const pool = { query: async (sql: string) => { queries.push(sql); return { rows: [], rowCount: 0 }; } };
  await new ScheduledPostsRepository(pool as any).markStaleUnknown();
  const sql = queries[0].replace(/\s+/g, ' ');
  assert.match(sql, /SET status='unknown'/);
  assert.match(sql, /WHERE status='sending' AND updated_at < now\(\) - interval '5 minutes'/);
  assert.match(sql, /RETURNING \*/);
});
