import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NavAttentionService, chatCardLive } from './nav-attention.service';
import { BADGE_SOURCES } from './nav-badges.service';

const AT = new Date('2026-10-18T09:00:00Z');

test('attention: the rows behind each counter, with the handles and chats to link to', async () => {
  const sql: string[] = [];
  const pool = {
    query: async (q: string) => {
      sql.push(q);
      if (q.includes('FROM agent_inbox')) return { rows: [{ id: '7', title: '⚠️ threads:1: token_invalid', severity: 'critical', kind: 'resource_health', created_at: AT, handle: 'nova', total: '3' }] };
      if (q.includes('FROM agent_directives')) return { rows: [] };
      return { rows: [{ id: 'p1', chat_id: 'c1', title: 'Ідеї для nova', kind: 'owner_rule', summary: 'Правило: без хештегів', created_at: AT, handle: 'nova', total: '1' }] };
    },
  };
  const a = await new NavAttentionService(pool as any).get();
  assert.deepEqual(a.inbox, { total: 3, items: [{ id: 7, title: '⚠️ threads:1: token_invalid', severity: 'critical', kind: 'resource_health', agentHandle: 'nova', createdAt: AT.toISOString() }] });
  assert.deepEqual(a.directives, { total: 0, items: [] });
  assert.equal(a.chatCards.items[0].chatId, 'c1');
  assert.equal(a.chatCards.items[0].chatTitle, 'Ідеї для nova');
  assert.ok(sql.some((q) => q.includes(`p.status = 'pending' AND p.created_at > now() - interval '24 hours'`)), 'only cards that can still be applied');
});

test('attention: a missing table is an empty list; other errors surface', async () => {
  const missing = new NavAttentionService({ query: async (): Promise<any> => { throw Object.assign(new Error('no table'), { code: '42P01' }); } });
  assert.deepEqual((await missing.get()).chatCards, { total: 0, items: [] });
  const down = new NavAttentionService({ query: async (): Promise<any> => { throw new Error('down'); } });
  await assert.rejects(down.get(), /down/);
});

test('the Chat counter counts only cards that can still be applied (an expired card no longer waits)', () => {
  const src = BADGE_SOURCES.find((s) => s.key === 'chatPendingActions')!;
  assert.ok(src.expr.includes(chatCardLive()), src.expr);
});
