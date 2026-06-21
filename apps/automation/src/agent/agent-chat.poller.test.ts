import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentChatPoller } from './agent-chat.poller';

function harness(opts: { enabled?: boolean; chats?: any[]; messages?: Record<string, any[]>; max?: number }) {
  const classified: string[] = []; const upserts: any[] = [];
  const client = { fetchChatMessages: async (chatId: string) => (opts.messages ?? {})[chatId] ?? [] } as any;
  const classifier = { classify: async (t: string) => { classified.push(t); return { kind: 'ad_offer', summary: '', score: 1, suggestedAction: 'advertise' }; } } as any;
  const chats = {
    enabled: async () => opts.chats ?? [],
    lastMessageId: async () => 0,
    setLastMessageId: async () => {},
  } as any;
  const opps = { upsert: async (m: any) => { upserts.push(m); } } as any;
  const config = { get: (k: string) => (k === 'AGENT_CHAT_ENABLED' ? (opts.enabled ? 'true' : 'false') : k === 'AGENT_CHAT_MAX' ? String(opts.max ?? 20) : undefined) } as any;
  return { poller: new AgentChatPoller(client, classifier, chats, opps, config), classified, upserts };
}
const msg = (id: number, text: string) => ({ messageId: id, text, date: new Date() });

test('no-op when disabled', async () => {
  const h = harness({ enabled: false, chats: [{ chat_id: 'c1', title: 'C' }], messages: { c1: [msg(1, 'реклама 500 грн')] } });
  const r = await h.poller.pollOnce();
  assert.equal(r.classified, 0); assert.equal(h.upserts.length, 0);
});
test('pre-filter drops non-candidates (classifier NOT called)', async () => {
  const h = harness({ enabled: true, chats: [{ chat_id: 'c1', title: 'C' }], messages: { c1: [msg(1, 'привіт як справи')] } });
  const r = await h.poller.pollOnce();
  assert.equal(h.classified.length, 0); assert.equal(r.classified, 0);
});
test('candidates are classified + upserted', async () => {
  const h = harness({ enabled: true, chats: [{ chat_id: 'c1', title: 'C' }], messages: { c1: [msg(1, 'привіт'), msg(2, 'шукаю рекламу 500 грн')] } });
  const r = await h.poller.pollOnce();
  assert.equal(h.classified.length, 1); assert.equal(r.classified, 1);
  assert.equal(h.upserts[0].messageId, 2);
});
test('respects AGENT_CHAT_MAX', async () => {
  const chats = Array.from({ length: 5 }, (_, i) => ({ chat_id: 'c' + i, title: 'C' }));
  const messages: any = {}; chats.forEach(c => { messages[c.chat_id] = [msg(1, 'реклама 500 грн')]; });
  const h = harness({ enabled: true, chats, messages, max: 2 });
  await h.poller.pollOnce();
  assert.equal(h.upserts.length, 2); // only first 2 chats polled
});
