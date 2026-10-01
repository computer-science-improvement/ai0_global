import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inviteName, userHash, utmUrl } from './tracked-links';
import { relevance } from './promo-planner';
import { PromoExecutor } from './promo-executor';
import { emitChatMember, onChatMember } from '../../publishers/chat-member-bus';
import { ResourceProfileSchema } from '../agents/resource-profile';

const profile = (topic: string, who = 'дорослі новачки', taboo: string[] = []) =>
  ResourceProfileSchema.parse({ topic, audience: { who }, goals: ['growth'], taboo });

test('invite names fit the Bot API limit; UTM; salted hashes', () => {
  const n = inviteName('instagram:0b5f3c1e-aaaa-bbbb-cccc-1234567890ab', '11111111-2222-3333-4444-555555555555');
  assert.ok(n.length <= 32);
  assert.match(n, /^src:in:/);
  assert.equal(utmUrl('https://example.com/a?x=1', { source: 'telegram', medium: 'promo', campaign: 'abc' }),
    'https://example.com/a?x=1&utm_source=telegram&utm_medium=promo&utm_campaign=abc');
  assert.equal(userHash(42, 's1'), userHash(42, 's1'));
  assert.notEqual(userHash(42, 's1'), userHash(42, 's2'));
  assert.ok(!userHash(42, 's1').includes('42'));
});

test('relevance: overlapping topics pass, unrelated and taboo fail, unknown is neutral', () => {
  const space = profile('Космос, астрономія, телескопи і планети простою мовою', 'школярі й дорослі, що цікавляться космосом');
  const astro = profile('Астрономія для початківців: телескопи, планети, зорі', 'дорослі новачки в астрономії');
  const recipes = profile('Рецепти домашньої кухні на кожен день', 'господині та студенти');
  const noAstrology = profile('Наука про космос', 'всі', ['астрологія']);
  const astrology = profile('астрологія і гороскопи на кожен день', 'всі');
  assert.ok(relevance(space, astro).score >= 3, relevance(space, astro).note);
  assert.ok(relevance(space, recipes).score < 3);
  assert.equal(relevance(noAstrology, astrology).score, 1);
  assert.equal(relevance(null, space).score, 3);
});

test('chat_member bus: listeners get updates; a throwing listener never breaks the loop', async () => {
  const seen: number[] = [];
  const off1 = onChatMember(() => { throw new Error('boom'); });
  const off2 = onChatMember((u) => { seen.push(u.new_chat_member.user.id); });
  await emitChatMember({ chat: { id: 1 }, new_chat_member: { status: 'member', user: { id: 7 } }, invite_link: { invite_link: 'https://t.me/+x', name: 'src:in:x' } });
  off1(); off2();
  await emitChatMember({ chat: { id: 1 }, new_chat_member: { status: 'member', user: { id: 8 } } });
  assert.deepEqual(seen, [7]);
});

function executor(o: { mode?: 'live' | 'shadow'; forwardFails?: string; after?: string } = {}) {
  const updates: any[] = [];
  const runs: any[] = [];
  const ex = new PromoExecutor({
    plans: { updateSlot: async (id: string, p: any) => { updates.push([id, p]); }, getSlot: async () => ({ status: o.after ?? 'shadowed' }) as any },
    card: async () => ({ mode: o.mode ?? 'live' }) as any,
    catalog: { list: async () => [{ ref: 'telegram:@astro', title: 'Астро', username: 'astro' }] as any },
    profiles: { get: async () => ({ profile: profile('Астрономія для початківців') }) as any },
    runExecutor: async (slot, _card, note) => { runs.push(note); return { status: 'ok' } as any; },
    forward: async (to, from, id) => { if (o.forwardFails) throw new Error(o.forwardFails); return 555 + id - id; },
  });
  return { ex, updates, runs };
}

test('promo executor: Telegram repost forwards natively (shadow only records); a deleted source is skipped', async () => {
  const live = executor();
  assert.equal(await live.ex.publishPromo({ id: 's1', channelKey: '@space', promo: { kind: 'repost', post_ref: 'telegram:@astro/123' } } as any, new Date()), true);
  assert.equal(live.updates[0][1].status, 'published');
  const shadow = executor({ mode: 'shadow' });
  await shadow.ex.publishPromo({ id: 's1', channelKey: '@space', promo: { kind: 'repost', post_ref: 'telegram:@astro/123' } } as any, new Date());
  assert.equal(shadow.updates[0][1].status, 'shadowed');
  const gone = executor({ forwardFails: 'Bad Request: message to forward not found' });
  await gone.ex.publishPromo({ id: 's1', channelKey: '@space', promo: { kind: 'repost', post_ref: 'telegram:@astro/123' } } as any, new Date());
  assert.equal(gone.updates[0][1].status, 'skipped');
  assert.match(gone.updates[0][1].error, /source_missing/);
});

test('promo executor: cross-promo runs the agent with the target and the tracked link; an unfinished run fails the slot', async () => {
  const ok = executor();
  assert.equal(await ok.ex.publishPromo({ id: 's2', channelKey: '@space', promo: { kind: 'cross_promo', target_ref: 'telegram:@astro', link_url: 'https://t.me/+abc' } } as any, new Date()), true);
  assert.match(ok.runs[0], /Ціль: Астро/);
  assert.match(ok.runs[0], /https:\/\/t\.me\/\+abc/);
  assert.match(ok.runs[0], /Астрономія для початківців/);
  const stuck = executor({ after: 'running' });
  assert.equal(await stuck.ex.publishPromo({ id: 's3', channelKey: '@space', promo: { kind: 'cross_promo', target_ref: 'telegram:@astro' } } as any, new Date()), false);
  assert.equal(stuck.updates.at(-1)[1].status, 'failed');
});
