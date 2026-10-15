import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEntities } from '../post/entities';
import { criticUserPrompt } from '../critic/critic.service';
import { TelegramEditorPublisher } from '../publish/telegram-editor.publisher';
import { assembleQuality } from '../manager/quality-digest';
import { activeStoriesBlock, coveringStory, criticStoryLines, namesOnly, type ActiveStory } from './story-context';
import { repostShare } from './repost-stats';

/** Spec 037 T2: what the agents see of the registry (prompt blocks), the reply on send, the repost share. */

const NOW = new Date('2026-10-09T09:00:00Z');
const story = (over: Partial<ActiveStory> = {}): ActiveStory => ({
  key: 'apple-home-hub', title: 'Apple і LG роблять розумний дім', kind: 'news', firstPostAt: '2026-10-07T07:00:00.000Z',
  lastPostAt: '2026-10-07T07:00:00.000Z', posts: 1, originalRef: 'slot-0', keyFacts: ['ціна $349'], eventAt: null, siblings: [],
  entities: extractEntities('Apple Home Hub з екраном керуватиме замком і термостатом від LG. Партнерство Apple та LG.'), ...over,
});

test('Active stories block: the planner and the writer get the rule and one line per story', () => {
  const planner = activeStoriesBlock([story()], { timezone: 'Europe/Kyiv', now: NOW, role: 'planner' })!;
  assert.match(planner, /^## Активні історії \(14 днів\)\nНе плануй ці історії знову/);
  assert.match(planner, /- apple-home-hub: «Apple і LG роблять розумний дім» · 1 пост\(и\) тут, останній .*оригінал slot-0 · факти: ціна \$349/);
  const sib = story({ key: 'gemini-agent', title: 'Gemini Agent', posts: 0, originalRef: null, keyFacts: [], siblings: [{ channelKey: 'ai_tech', at: '2026-10-09T06:00:00.000Z', postRef: 'telegram:ai_tech/55' }] });
  const writer = activeStoriesBlock([story(), sib], { timezone: 'Europe/Kyiv', now: NOW, role: 'executor' })!;
  assert.match(writer, /story \{ followup_of: <id оригіналу>, kind: "followup", new_facts/);
  assert.match(writer, /- gemini-agent: «Gemini Agent» · сусідні канали: ai_tech .*\(telegram:ai_tech\/55\) · вийшла в сусіда за 24 год → skip \/ own_angle \/ request_story_repost/);
  // A sibling's story older than 24 h that the resource never told is not listed; nothing → no block.
  assert.equal(activeStoriesBlock([{ ...sib, siblings: [{ ...sib.siblings[0], at: '2026-10-07T06:00:00.000Z' }] }], { timezone: 'Europe/Kyiv', now: NOW, role: 'planner' }), null);
  assert.equal(activeStoriesBlock([], { timezone: 'Europe/Kyiv', now: NOW, role: 'planner' }), null);
});

test('fetch_feed: an item an active story covers is marked; an unrelated or brand-only item is not', () => {
  const stories = [story()];
  assert.equal(coveringStory({ title: 'Apple Home Hub to launch with LG smart lock and thermostat' }, stories), 'apple-home-hub');
  assert.equal(coveringStory({ title: 'Apple Home Hub отримає замок і термостат від LG' }, stories), 'apple-home-hub');
  assert.equal(coveringStory({ title: 'Apple reports record iPhone sales' }, stories), null);
  assert.equal(coveringStory({ title: 'Nvidia unveils Rubin GPUs' }, stories), null);
  assert.equal(namesOnly('OpenAI raises $40 billion'), 'OpenAI · $40 billion');
  assert.equal(namesOnly('Apple і LG роблять дім'), 'Apple і LG роблять дім', 'a Ukrainian text is left as is');
});

test('the critic prompt gets the story\'s earlier posts and the first post date', () => {
  const ctx = { role: 'followup', firstPostAt: '2026-10-07T07:00:00.000Z', newFacts: ['$349'],
    posts: [{ at: '2026-10-07T07:00:00.000Z', channel: '@chan', lead: 'Apple і LG роблять розумний дім', facts: ['Apple Home Hub', 'LG'] },
      { at: '2026-10-09T05:00:00.000Z', channel: 'ai_tech', lead: 'Gemini', facts: [], sibling: true }] };
  const lines = criticStoryLines(ctx, 'Europe/Kyiv');
  assert.equal(lines[1], '## Історія цього поста (попередні пости)');
  assert.match(lines.join('\n'), /Роль поста: followup/);
  assert.match(lines.join('\n'), /«Apple і LG роблять розумний дім» — Apple Home Hub, LG/);
  assert.match(lines.join('\n'), /\(сусідній канал ai_tech\)/);
  assert.match(lines.join('\n'), /Нові факти за словами автора: «\$349»/);
  assert.deepEqual(criticStoryLines(null, 'Europe/Kyiv'), []);
  const prompt = criticUserPrompt({
    channelKey: '@chan', slotId: 's', mode: 'live', resourceRef: 'telegram:@chan', platform: 'telegram', format: 'text', text: 'Текст', spec: {},
    voice: {}, slopWarnings: [], story: ctx,
    dates: { publishAt: '2026-10-09T07:00:00.000Z', timezone: 'Europe/Kyiv', storyFirstPostAt: ctx.firstPostAt },
  } as any);
  assert.match(prompt, /Перший пост цієї історії на ресурсі/);
  assert.match(prompt, /## Історія цього поста/);
});

test('a follow-up is sent as a reply to its original (the first message only, sent anyway if the original is gone)', async () => {
  const calls: any[] = [];
  let id = 10;
  const pub = new TelegramEditorPublisher(
    { resolveChannel: () => ({ chatId: '-100', botToken: 't' }), isPublishPausedFor: () => false } as any,
    async (url: string, body: any) => { calls.push([url.split('/').pop(), body]); return { data: { ok: true, result: { message_id: ++id } } } as any; },
  );
  await pub.send('@chan', [
    { method: 'sendMessage', text: 'Текст', preview: null, buttons: [] } as any,
    { method: 'sendPoll', question: 'Q?', options: ['a', 'b'], quiz: false, correctIndex: null, explanation: null, anonymous: true },
  ], { replyTo: 77 });
  assert.deepEqual(calls[0][1].reply_parameters, { message_id: 77, allow_sending_without_reply: true });
  assert.equal(calls[1][1].reply_parameters, undefined);
  calls.length = 0;
  await pub.send('@chan', [{ method: 'sendMessage', text: 'Текст', preview: null, buttons: [] } as any]);
  assert.equal(calls[0][1].reply_parameters, undefined);
});

test('MANAGER quality block: the repost share, flagged over 30 %', () => {
  assert.deepEqual(repostShare(7, 3), { own: 7, reposts: 3, share: 0.3, over: false });
  assert.deepEqual(repostShare(6, 4), { own: 6, reposts: 4, share: 0.4, over: true });
  assert.deepEqual(repostShare(0, 0), { own: 0, reposts: 0, share: null, over: false });
  const base = { critic: [], posts: [], owner: [], caps: { pollsPerWeek: null, questionsPerDay: 1 } as any };
  const q = assembleQuality({ ...base, reposts: { own: 2, reposts: 3 } });
  assert.deepEqual(q.reposts, { own: 2, reposts: 3, share: 0.6, over: true });
  assert.ok(q.flags.includes('repost_share_high'));
  const none = assembleQuality(base);
  assert.equal(none.reposts, undefined);
  assert.ok(!none.flags.includes('repost_share_high'));
});
