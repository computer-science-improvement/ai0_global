// locked-agent-options.ts — Agent SDK options for RUNTIME classifier agents
// (semantic dedup, topic router). These agents read untrusted input (scraped
// news, generated posts), so they get no tools at all and no filesystem
// settings (constitution §V):
//
//   - permissionMode 'default' (never bypassPermissions),
//   - tools: [] + allowedTools: [] → no Bash/Read/Write/WebFetch …,
//   - settingSources: [] → the project's .claude/settings.json (which
//     allow-lists Bash(*) etc. for dev use) is NOT loaded.
//
// With settingSources [] the SDK no longer discovers .claude/agents/*.md, so
// the agent's prompt is read from that file here and passed inline via
// `agents`, with its tools forced to [].
import { readFileSync } from 'fs';
import { join } from 'path';
import type { AgentDefinition, Options } from '@anthropic-ai/claude-agent-sdk';

/** Parse a Claude Code agent markdown file (YAML-ish frontmatter + prompt body). */
export function parseAgentMarkdown(md: string): AgentDefinition {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!m) throw new Error('agent markdown has no frontmatter');
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return {
    description: meta.description ?? '',
    prompt:      m[2].trim(),
    ...(meta.model ? { model: meta.model } : {}),
    tools:       [],
  };
}

const cache = new Map<string, AgentDefinition>();

function loadAgent(cwd: string, name: string): AgentDefinition {
  const file = join(cwd, '.claude', 'agents', `${name}.md`);
  let def = cache.get(file);
  if (!def) {
    def = parseAgentMarkdown(readFileSync(file, 'utf8'));
    cache.set(file, def);
  }
  return def;
}

/** Locked-down query() options that run `.claude/agents/<name>.md` as the main agent. */
export function lockedAgentOptions(cwd: string, name: string, maxTurns: number): Options {
  return {
    cwd,
    settingSources: [],
    agent:          name,
    agents:         { [name]: loadAgent(cwd, name) },
    tools:          [],
    allowedTools:   [],
    permissionMode: 'default',
    maxTurns,
  };
}
