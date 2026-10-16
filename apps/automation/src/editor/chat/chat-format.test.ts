/** Every dashboard chat prompt tells the agent which markdown the chat renders (dashboard lib/markdown-lite.tsx). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_FORMAT_RULE } from './chat-format';
import { buildComposerSystemPrompt } from '../roles/prompts';
import { buildBuilderPrompt, buildManagerChatPrompt } from '../agents/agent-prompts';
import { SkillLibrary } from '../skills/skill-library';

const NOW = new Date('2026-10-16T09:00:00Z');

test('composer, @ai0 and @manager chat prompts carry the chat format rule', () => {
  const skills = new SkillLibrary();
  const prompts = {
    composer: buildComposerSystemPrompt({ now: NOW, card: null, hasCard: false, memory: [], skills }),
    builder:  buildBuilderPrompt({ now: NOW, skills, agentsSummary: '' }),
    manager:  buildManagerChatPrompt({ now: NOW, skills, agent: { name: 'Manager', handle: 'manager' } as any }),
  };
  for (const [role, p] of Object.entries(prompts)) assert.ok(p.includes(CHAT_FORMAT_RULE), role);
});

test('the rule names the table syntax and the escaped pipe, and keeps post markup separate', () => {
  assert.match(CHAT_FORMAT_RULE, /\|---\|/);
  assert.match(CHAT_FORMAT_RULE, /\\\|/);
  assert.match(CHAT_FORMAT_RULE, /PostSpec/);
});
