/** Spec 048 FR-003: slash commands run in code — no model turn — and answer with one line and artifact chips. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../harness/agent-loop';
import { ToolRegistry } from '../harness/tool-registry';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import { SkillLibrary } from '../skills/skill-library';
import type { EditorChatMessage } from '../repo/editor-chat.repository';
import type { ArtifactRow } from '../artifacts/artifact.types';
import { EditorChatService } from './editor-chat.service';
import { parseSlash, runSlash, type SlashDeps } from './slash-commands';

const NOW = new Date('2026-10-18T09:00:00Z');

const row = (type: ArtifactRow['type'], id: string): ArtifactRow => ({
  type, id, title: `${type} ${id}`, agent: 'news', channel: '@news', target: '@news', status: 'active', version: 1, updatedAt: NOW.toISOString(), summary: '', live: true,
});

function deps() {
  const calls: unknown[][] = [];
  const d: SlashDeps = {
    setup: async (key) => { calls.push(['setup', key]); return key === '@other' ? { ok: false, error: 'not_own_channel' } : { ok: true, chip: { type: 'setup', id: 'p1', title: `Setup from history · ${key}`, status: 'queued' } }; },
    steer: async (key, ref) => { calls.push(['steer', key, ref]); return ref === '@news' ? { ok: false, error: 'same_channel' } : { ok: true, chip: { type: 'steering', id: 's1', title: 'Steering from ref', status: 'queued' } }; },
    launch: async (q) => { calls.push(['launch', q]); return { ok: true, chip: { type: 'launch', id: 'l1', title: `Launch · ${q.target}`, status: 'queued' } }; },
    list: async (q) => { calls.push(['list', q]); return q.channel === '@empty' ? [] : [row(q.type, q.channel ?? q.agent ?? 'all')]; },
  };
  return { d, calls };
}

test('parse: a command word at the start; a path is not a command; unknown words are kept', () => {
  assert.deepEqual(parseSlash('/steer @news t.me/ref'), { name: 'steer', word: 'steer', args: ['@news', 't.me/ref'], rest: '@news t.me/ref' });
  assert.deepEqual(parseSlash('  /help  '), { name: 'help', word: 'help', args: [], rest: '' });
  assert.equal(parseSlash('/app/setup is broken'), null);
  assert.equal(parseSlash('hello /setup'), null);
  assert.deepEqual(parseSlash('/stear @x'), { name: null, word: 'stear', args: ['@x'], rest: '@x' });
});

test('commands: the chat\'s channel fills a missing @channel; wrong arguments get the usage; refusals are one line', async () => {
  const { d, calls } = deps();
  const ctx = { agent: 'news', channel: '@news' };
  const s = await runSlash(parseSlash('/setup')!, ctx, d);
  assert.deepEqual(s.artifacts.map((a) => [a.type, a.status]), [['setup', 'queued']]);
  assert.deepEqual(calls[0], ['setup', '@news']);
  assert.match((await runSlash(parseSlash('/setup @other')!, ctx, d)).content, /^@other is not one of your tracked channels\.$/);
  assert.equal((await runSlash(parseSlash('/setup a b')!, ctx, d)).content, 'Usage: /setup @channel');
  assert.equal((await runSlash(parseSlash('/setup')!, { agent: null, channel: null }, d)).content, 'Usage: /setup @channel');

  const st = await runSlash(parseSlash('/steer https://t.me/ref_chan')!, ctx, d);
  assert.deepEqual(calls.at(-1), ['steer', '@news', 'https://t.me/ref_chan']);
  assert.equal(st.artifacts[0].type, 'steering');
  await runSlash(parseSlash('/steer t.me/mine @ref')!, ctx, d);
  assert.deepEqual(calls.at(-1), ['steer', '@mine', '@ref'], 'a t.me link is our channel too');
  assert.match((await runSlash(parseSlash('/steer @news @news')!, ctx, d)).content, /the reference must be another channel/);

  assert.equal((await runSlash(parseSlash('/rules')!, ctx, d)).artifacts[0].id, '@news');
  assert.equal((await runSlash(parseSlash('/memory @empty')!, ctx, d)).content, '@empty has nothing learnt yet.');
  assert.equal((await runSlash(parseSlash('/rules')!, { agent: null, channel: null }, d)).content, 'Name the channel: /rules [@channel]');
  assert.deepEqual(calls.at(-1), ['list', { type: 'memory', channel: '@empty' }]);
  await runSlash(parseSlash('/skills @Kira!')!, ctx, d);
  assert.deepEqual(calls.at(-1), ['list', { type: 'memory', channel: '@empty' }], 'a bad handle never reaches the registry');
  assert.equal((await runSlash(parseSlash('/skills')!, ctx, d)).content, 'Skills of @news:');
  assert.match((await runSlash(parseSlash('/stear')!, ctx, d)).content, /^There is no command \/stear\.\nCommands:\n\/setup @channel — /);
});

test('the chat service answers a command without a model run and stores the chips on the message', async () => {
  const messages: EditorChatMessage[] = [];
  const titles: Array<string | undefined> = [];
  const repo: any = {
    createChat: async () => ({ id: 'c1' }), listChats: async () => [], deleteChat: async () => true,
    touchChat: async (_c: string, t?: string) => { titles.push(t); },
    getChat: async () => ({ id: 'c1', title: 't', createdAt: NOW, updatedAt: NOW, agentId: 'a-news' }),
    addMessage: async (m: any) => {
      const r = { id: messages.length + 1, chatId: m.chatId, role: m.role, content: m.content, draftIds: [], runId: null, artifacts: m.artifacts ?? null, createdAt: NOW };
      messages.push(r);
      return r;
    },
    listMessages: async () => [...messages], listDrafts: async () => [], myChannels: async () => [],
  };
  const llm = new FakeLlm([]);
  const { d } = deps();
  const news: any = { id: 'a-news', handle: 'news', kind: 'orchestrator', parentId: null };
  const svc = new EditorChatService({
    repo, drafts: {} as any, memory: { listActive: async () => [] }, skills: new SkillLibrary(), registry: new ToolRegistry([]),
    loop: new AgentLoop({ llm, recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true }),
    env: () => undefined, enabled: () => true, now: () => NOW, slash: d,
    agents: { get: async () => news, channelKeyOf: async () => '@news', handles: async () => ['news'] } as any,
  });
  const events: any[] = [];
  const r = await svc.sendMessage('c1', '/rules', { onEvent: (e) => events.push(e) });
  assert.equal(llm.requests.length, 0);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(r.message.content, 'Your rules for @news:');
  assert.deepEqual((r.message as any).artifacts.map((a: any) => a.id), ['@news']);
  assert.equal(events.find((e) => e.type === 'message').message.id, r.message.id);
  assert.deepEqual(titles, ['/rules']);
});
