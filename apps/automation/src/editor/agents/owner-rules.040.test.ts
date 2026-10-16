import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOwnerRule, buildAgentChatTools, OWNER_RULE_KIND, ruleSources, unknownSkills } from './agent-chat-tools';
import { ownerRecent } from '../chat/editor-chat.service';

/** Spec 040 FR-010: owner rules capture. */

function setup(o: { shared?: string[]; own?: string[] } = {}) {
  const adds: any[] = [];
  const proposed: any[] = [];
  const streamed: any[] = [];
  const tool = buildAgentChatTools({
    pool: { query: async () => ({ rows: [] }) } as any,
    memory: { add: async (...a: any[]) => { adds.push(a); return 11; } },
    skills: { findShared: async (n: string) => ((o.shared ?? []).includes(n) ? ({ name: n } as any) : null) },
    actions: { propose: async (a: any) => { proposed.push(a); return { id: 'pa1', ...a, status: 'pending' } as any; } },
  }).find((t) => t.name === 'add_owner_rule')!;
  const ctx = (ownerRecent: string[]) => ({
    runId: 'r', role: 'composer', channelKey: '@chan',
    extras: {
      chat: { chatId: 'c1', channelKey: '@chan' }, agentIntent: false, ownerText: ownerRecent.at(-1), ownerRecent,
      onAction: (a: any) => streamed.push(a), agent: { id: 'a-kira', handle: 'kira' },
      skills: { get: (n: string) => ((o.own ?? []).includes(n) ? { name: n } : undefined) },
    },
  }) as any;
  return { tool, ctx, adds, proposed, streamed };
}

test('a rule matching any of the owner\'s last 5 messages is stored with the owner\'s words as source_text', async () => {
  const s = setup();
  const recent = ['Пости мають бути без сленгу і без англіцизмів', 'а ще без хештегів у телеграмі', 'що там з планом?'];
  const r: any = await s.tool.execute({ text: 'Без хештегів у Telegram', kind: 'rule' }, s.ctx(recent));
  assert.equal(r.ok, true);
  assert.equal(r.id, 11);
  assert.equal(s.adds[0][0], '@chan');
  assert.equal(s.adds[0][4], 'owner');
  assert.equal(s.adds[0][5], 'а ще без хештегів у телеграмі', 'the best-matching message, not the latest');
});

test('low overlap is not refused: the owner gets an owner_rule card with the quotes, nothing is stored', async () => {
  const s = setup();
  const recent = ['Кожен пост має пройти 8 пунктів перевірки перед публікацією', 'так, додай це як правило'];
  const r: any = await s.tool.execute({ text: 'Перед публікацією перевіряй факти, джерела, дати та стиль за чеклістом', kind: 'rule' }, s.ctx(recent));
  assert.equal(r.ok, true);
  assert.equal(r.stored, false);
  assert.equal(s.adds.length, 0);
  assert.equal(s.proposed[0].kind, OWNER_RULE_KIND);
  assert.equal(s.proposed[0].payload.channel, '@chan');
  assert.match(s.proposed[0].payload.quotes[0], /8 пунктів/);
  assert.equal(s.streamed.length, 1, 'the card reaches the chat');
});

test('a rule naming a missing skill is refused (unknown_skill); an existing one passes', async () => {
  const s = setup({ shared: ['voice-core'], own: ['kira-recipes'] });
  const bad: any = await s.tool.execute({ text: 'Завжди бери картинки зі скіла poster-bank', kind: 'rule' }, s.ctx(['Завжди бери картинки зі скіла poster-bank']));
  assert.equal(bad.error, 'unknown_skill');
  assert.match(bad.details, /poster-bank/);
  assert.deepEqual(await unknownSkills('Тримайся скіла voice-core і kira-recipes', { get: (n) => (n === 'kira-recipes' ? {} : undefined) }, { findShared: async (n) => (n === 'voice-core' ? ({} as any) : null) }), []);
  assert.deepEqual(await unknownSkills('Без пост-іронії', undefined, { findShared: async () => null }), [], 'no skill mentioned — nothing to check');
});

test('applying the card stores the rule with the quotes; recent messages are the last five, oldest first', async () => {
  const adds: any[] = [];
  const r = await applyOwnerRule({ add: async (...a: any[]) => { adds.push(a); return 5; } }, { channel: '@chan', kind: 'rule', text: 'Кожен пост проходить 8 пунктів', quotes: ['Кожен пост має пройти 8 пунктів'] });
  assert.deepEqual(r, { id: 5, channel: '@chan' });
  assert.equal(adds[0][5], 'Кожен пост має пройти 8 пунктів');
  await assert.rejects(applyOwnerRule({ add: async () => 1 }, { channel: '', text: 'x' }));
  const prior = [1, 2, 3, 4, 5, 6].flatMap((i) => [{ role: 'user', content: `u${i}` }, { role: 'assistant', content: `a${i}` }]) as any;
  assert.deepEqual(ownerRecent(prior, 'now'), ['u3', 'u4', 'u5', 'u6', 'now']);
  assert.equal(ruleSources('без хештегів', ['привіт', 'без хештегів будь ласка'])[0].text, 'без хештегів будь ласка');
});
