// Spec 062 FR-008: the links that resolve config conflicts prefill `/align @handle`; the card lists its items.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { alignPrompt, resolverItemLines } from './align';
import { isSlashCommand } from '../components/chat/SlashMenu';

test('the prefill is the /align command for the agent, a slash command the server runs without a model turn', () => {
  assert.equal(alignPrompt('kira'), '/align @kira');
  assert.equal(alignPrompt('@kira'), '/align @kira');
  assert.ok(isSlashCommand(alignPrompt('kira')));
});

test('both "Resolve in one card" links use it, not a free-text message to the agent', () => {
  for (const f of ['../components/agents/AgentOverview.tsx', '../components/agents/AgentMemoryHistory.tsx']) {
    const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
    assert.ok(src.includes('alignPrompt('), f);
    assert.ok(!src.includes('fix config conflicts'), `${f} no longer sends the free-text request`);
  }
});

test('the resolver card lists its first items and counts the rest', () => {
  const items = ['Approve playbook v3', 'Retire rule #7', 'slang on', 'hashtags off'].map((detail, i) => ({ key: `k${i}`, kind: 'conflict', detail }));
  assert.deepEqual(resolverItemLines({ handle: 'kira', items }), { lines: ['Approve playbook v3', 'Retire rule #7', 'slang on'], more: 1 });
  assert.deepEqual(resolverItemLines({ items: items.slice(0, 2) }, 3), { lines: ['Approve playbook v3', 'Retire rule #7'], more: 0 });
  assert.deepEqual(resolverItemLines({ items: [{ key: 'a', detail: '  two\n lines ' }, { key: 'b' }, null] }), { lines: ['two lines'], more: 0 });
  assert.deepEqual(resolverItemLines({ conflicts: [{ detail: 'old shape' }] }), { lines: [], more: 0 }, 'a card of the old shape has no items');
  assert.deepEqual(resolverItemLines(null), { lines: [], more: 0 });
});
