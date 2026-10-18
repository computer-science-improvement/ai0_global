/** Spec 047 FR-006: one voice per agent, no unrequested offers, and the composer looks before it judges a pasted post. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentPersona, buildBuilderPrompt, buildManagerChatPrompt, NO_UNREQUESTED_OFFERS, voiceLine } from './agent-prompts';
import { AgentsService } from './agents.service';
import { buildComposerSystemPrompt } from '../roles/prompts';
import { SkillLibrary } from '../skills/skill-library';
import { makeCard } from '../post/testing/fixtures';

const NOW = new Date('2026-10-17T09:00:00Z');
const lib = new SkillLibrary();
const agent = (g: 'masculine' | 'feminine' | null, kind = 'orchestrator'): any =>
  ({ id: 'a1', handle: 'nova_dev', name: 'Nova', emoji: null, kind, parentId: null, scope: 'resource', scopeId: 'telegram:@nova', mode: 'live', status: 'active', grammaticalGender: g });

test('the voice line is fixed per agent: null and masculine are masculine, feminine is feminine', () => {
  assert.match(voiceLine(agent(null)), /чоловічому роді.*Не змінюй рід/);
  assert.match(voiceLine(agent('masculine')), /«я зробив»/);
  assert.match(voiceLine(agent('feminine')), /жіночому роді.*«я зробила»/);
  assert.match(voiceLine(undefined), /чоловічому/);
});

test('persona, builder and manager prompts carry the voice line and the no-offers rule', () => {
  const persona = agentPersona(agent('feminine'), null);
  assert.ok(persona.includes(voiceLine(agent('feminine'))));
  assert.ok(persona.includes(NO_UNREQUESTED_OFFERS));
  const builder = buildBuilderPrompt({ now: NOW, skills: lib, agentsSummary: '', agent: agent(null, 'builder') });
  assert.ok(builder.includes(voiceLine(null)) && builder.includes(NO_UNREQUESTED_OFFERS));
  const manager = buildManagerChatPrompt({ now: NOW, skills: lib, agent: agent('feminine', 'manager') });
  assert.ok(manager.includes(voiceLine(agent('feminine'))) && manager.includes(NO_UNREQUESTED_OFFERS));
});

test('the composer looks a pasted post up before judging it', () => {
  const p = buildComposerSystemPrompt({ now: NOW, card: makeCard({}), hasCard: true, memory: [], skills: lib });
  assert.match(p, /знайди його в даних \(get_recent_posts; інші платформи — get_network_posts\)/);
  assert.match(p, /Не кажи «не бачу в даних», доки не пошукав/);
});

test('PATCH grammatical_gender: feminine, back to null; other values are refused', async () => {
  const a = agent(null);
  const updates: any[] = [];
  const svc = new AgentsService({
    pool: { query: async () => ({ rows: [] }) } as any,
    agents: { getByHandle: async () => a, update: async (_id: string, p: any) => { updates.push(p); return { ...a, ...p }; } } as any,
    skills: {} as any, inbox: {} as any,
    setChannelMode: async () => {}, runNow: async () => ({ started: false, what: '' }), memory: async () => [],
  });
  await svc.patch('nova_dev', { grammatical_gender: 'feminine' });
  await svc.patch('nova_dev', { grammatical_gender: null });
  assert.deepEqual(updates.map((u) => u.grammaticalGender), ['feminine', null]);
  await assert.rejects(svc.patch('nova_dev', { grammatical_gender: 'neuter' }));
});
