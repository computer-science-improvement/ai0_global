import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL_SKILL_ROLES, defaultAppliesTo, toneSkillForProfile } from './skill-defaults';
import { attachProfileTone } from './profile-tone';
import { SkillView } from './skill-library';
import { agentInlineSkills } from '../roles/prompts';
import { buildAgentChatTools } from '../agents/agent-chat-tools';
import { buildBuilderTools } from '../agents/builder-tools';
import { slotSkillsContext } from '../critic/critic-skills';

/** Spec 040 FR-012: owner and agent skills reach the writer and the critic. */

const TONES = ['tone-gaming', 'tone-movies', 'tone-recipes', 'tone-space', 'tone-daily-photo', 'tone-on-this-day', 'tone-birthday-story', 'tone-ai0-news', 'human-voice'];

test('a channel skill without roles is for the executor, the composer and the critic; system agents must say', () => {
  assert.deepEqual(CHANNEL_SKILL_ROLES, ['executor', 'composer', 'checker']);
  assert.deepEqual(defaultAppliesTo({ scope: 'resource' }), ['executor', 'composer', 'checker']);
  assert.deepEqual(defaultAppliesTo({ scope: 'network' }), ['executor', 'composer', 'checker']);
  assert.equal(defaultAppliesTo({ scope: 'system' }), null);
});

test('the profile tone picks one tone skill: a named one first, else a single clear family', () => {
  assert.equal(toneSkillForProfile({ tone: 'Як у tone-ai0-news: нейтрально' }, TONES), 'tone-ai0-news');
  assert.equal(toneSkillForProfile({ topic: 'Ігрові новини, роздачі й знижки в Steam' }, TONES), 'tone-gaming');
  assert.equal(toneSkillForProfile({ topic: 'Рецепти для дому' }, TONES), 'tone-recipes');
  assert.equal(toneSkillForProfile({ topic: 'Астрономічне фото дня (APOD) про космос' }, TONES), 'tone-daily-photo', 'the narrower family wins');
  assert.equal(toneSkillForProfile({ topic: 'Фільми та ігри' }, TONES), null, 'two families → none');
  assert.equal(toneSkillForProfile({ topic: 'Технології й стартапи' }, TONES), null, 'news tones attach only by name');
  assert.equal(toneSkillForProfile({ topic: 'Ігри' }, ['tone-movies']), null, 'a tone skill that does not exist is never named');
  assert.equal(toneSkillForProfile({ tone: 'tone-unknown' }, TONES), null);
  assert.equal(toneSkillForProfile(null, TONES), null);
});

test('attachProfileTone attaches the tone skill once and keeps what the owner set', async () => {
  const calls: any[] = [];
  let result: 'attached' | 'exists' | 'missing' = 'attached';
  const skills = { attachSharedIfUnset: async (agentId: string, name: string) => { calls.push([agentId, name]); return result; } };
  assert.equal(await attachProfileTone({ skills, available: () => TONES }, { id: 'a1' }, { topic: 'Новини кіно й серіалів' }), 'tone-movies');
  assert.deepEqual(calls, [['a1', 'tone-movies']]);
  result = 'exists';
  assert.equal(await attachProfileTone({ skills, available: () => TONES }, { id: 'a1' }, { topic: 'Новини кіно' }), null);
  assert.equal(await attachProfileTone({ skills, available: () => TONES }, { id: 'a1' }, { topic: 'Технології' }), null);
  assert.equal(calls.length, 2, 'no family → the store is not touched');
  const broken = { attachSharedIfUnset: async () => { throw new Error('db down'); } };
  assert.equal(await attachProfileTone({ skills: broken as any, available: () => TONES }, { id: 'a1' }, { topic: 'Кіно' }), null, 'never throws');
});

const skill = (name: string, body: string, appliesTo: any[] = ['executor']) => ({ name, description: `${name} skill`, appliesTo, body });

test('native platform and adapt writers get the agent\'s inline skills within the budget, without repeats', () => {
  const view = new SkillView(
    [skill('loko-channel-guide', 'Головний скіл каналу: '.padEnd(500, 'x')), skill('platform-instagram', 'IG'), skill('huge', 'y'.repeat(9_000)), skill('voice-core', 'v')],
    ['loko-channel-guide', 'platform-instagram', 'huge', 'voice-core'],
  );
  const got = agentInlineSkills(view, ['platform-instagram']);
  assert.deepEqual(got.names, ['loko-channel-guide'], 'platform skill excluded, voice-core never, over-budget skipped');
  assert.match(got.inline[0], /^### skill: loko-channel-guide\nГоловний скіл каналу/);
  assert.deepEqual(agentInlineSkills({ get: () => undefined, list: () => [] } as any, []).names, []);
});

test('the critic judges by the agent\'s inline skills and the attached tone skill', () => {
  const view = new SkillView([skill('loko-channel-guide', 'rules'), skill('tone-gaming', 'tone')], ['loko-channel-guide']);
  const c = slotSkillsContext({ sourceHints: [], topicMode: 'evergreen', liveSpec: null, seriesName: null } as any, { skills: [] }, view);
  assert.deepEqual([...(c.resource ?? [])].sort(), ['loko-channel-guide', 'tone-gaming']);
});

test('edit_my_skill without applies_to proposes the writer roles', async () => {
  const proposed: any[] = [];
  const tool = buildAgentChatTools({
    pool: { query: async () => ({ rows: [] }) } as any,
    skills: { findShared: async () => null },
    actions: { propose: async (a: any) => { proposed.push(a); return { id: 'pa1', ...a } as any; } },
  } as any).find((t) => t.name === 'edit_my_skill')!;
  const ctx: any = { runId: 'r', role: 'composer', channelKey: '@loko', extras: { chat: { chatId: 'c1' }, agentIntent: true, agent: { id: 'a1', handle: 'loko', scope: 'resource' } } };
  const r: any = await tool.execute({ name: 'loko-channel-guide', description: 'Головні правила каналу Loko', body: 'Пиши коротко, факт першим, без сленгу.' }, ctx);
  assert.equal(r.pending_action, 'pa1');
  assert.deepEqual(proposed[0].payload.applies_to, ['executor', 'composer', 'checker']);
});

test('write_skill without applies_to keeps the existing skill\'s roles, else the writer roles; a system agent must say', async () => {
  const proposed: any[] = [];
  const agents: Record<string, any> = { loko: { id: 'a1', handle: 'loko', scope: 'resource' }, manager: { id: 'm1', handle: 'manager', scope: 'system' } };
  const tool = buildBuilderTools({
    agents: { getByHandle: async (h: string) => agents[h] ?? null } as any,
    catalog: {} as any, profiles: {} as any, creator: {} as any,
    skills: {
      findShared: async () => null,
      findForAgent: async (_id: string, n: string) => (n === 'old-skill' ? { appliesTo: ['planner'] } as any : null),
    },
    actions: { propose: async (a: any) => { proposed.push(a); return { id: `pa${proposed.length}`, ...a }; } } as any,
  }).find((t) => t.name === 'write_skill')!;
  const ctx: any = { runId: 'r', role: 'builder', channelKey: null, extras: { chat: { chatId: 'c1' }, agentIntent: true } };
  const body = { description: 'Правила рубрики для каналу', body: 'Рубрика виходить щопʼятниці, один факт.' };
  await tool.execute({ handle: 'loko', name: 'new-skill', ...body }, ctx);
  await tool.execute({ handle: 'loko', name: 'old-skill', ...body }, ctx);
  assert.deepEqual(proposed.map((p) => p.payload.applies_to), [['executor', 'composer', 'checker'], ['planner']]);
  const sys: any = await tool.execute({ handle: 'manager', name: 'new-skill', ...body }, ctx);
  assert.equal(sys.error, 'new_skill_needs_meta');
});
