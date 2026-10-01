import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { lockedAgentOptions, parseAgentMarkdown } from './locked-agent-options';

const MD = [
  '---',
  'name: topic-router',
  'description: Routes a post. Returns a topic key or "none".',
  'model: haiku',
  'tools: [Bash, Read]',
  '---',
  '',
  'You route a Telegram post.',
  '',
  '## Output',
  'A single word.',
  '',
].join('\n');

test('parseAgentMarkdown: frontmatter → description/model, body → prompt', () => {
  const def = parseAgentMarkdown(MD);
  assert.equal(def.description, 'Routes a post. Returns a topic key or "none".');
  assert.equal(def.model, 'haiku');
  assert.equal(def.prompt, 'You route a Telegram post.\n\n## Output\nA single word.');
});

test('parseAgentMarkdown: a tools list in the file is IGNORED — runtime agents get none', () => {
  assert.deepEqual(parseAgentMarkdown(MD).tools, []);
});

test('parseAgentMarkdown: rejects a file without frontmatter', () => {
  assert.throws(() => parseAgentMarkdown('just a prompt'), /frontmatter/);
});

test('lockedAgentOptions: no shell, no settings, no permission bypass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'locked-agent-'));
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'agents', 'topic-router.md'), MD);

  const opts = lockedAgentOptions(dir, 'topic-router', 2);

  assert.equal(opts.permissionMode, 'default');
  assert.deepEqual(opts.allowedTools, []);
  assert.deepEqual(opts.tools, []);                 // built-in tools (Bash, Read, …) disabled
  assert.deepEqual(opts.settingSources, []);        // project .claude/settings.json NOT loaded
  assert.equal((opts as any).allowDangerouslySkipPermissions, undefined);
  assert.equal(opts.agent, 'topic-router');
  assert.equal(opts.maxTurns, 2);
  assert.equal(opts.agents?.['topic-router'].prompt.startsWith('You route'), true);
  assert.deepEqual(opts.agents?.['topic-router'].tools, []);
});

test('the real runtime agents (.claude/agents) load with prompts and no tools', () => {
  const cwd = join(__dirname, '..', '..', '..');
  for (const name of ['topic-novelty-checker', 'topic-router']) {
    const def = lockedAgentOptions(cwd, name, 2).agents![name];
    assert.ok(def.prompt.length > 100, `${name} prompt loaded`);
    assert.equal(def.model, 'haiku');
    assert.deepEqual(def.tools, []);
  }
});
