// Agent loadout (spec 054): grouping, locks, token lines and the skills / rules summaries of the Loadout tab.
// Pure (type-only imports), so node tests can import it.
import type { LoadoutMode, LoadoutRules, LoadoutSkill, LoadoutTool, ToolKind } from '../api/loadout';
import { fmtRelative } from './format';

export const KIND_ORDER: readonly ToolKind[] = ['read', 'act', 'terminal'];

export const KIND_LABEL: Record<ToolKind, { label: string; note: string }> = {
  read:     { label: 'Read', note: 'Look things up; no side effects.' },
  act:      { label: 'Act', note: 'Change something; the run goes on.' },
  terminal: { label: 'Finish', note: 'End the run (publish, plan, skip). Always offered.' },
};

export const MODE_LABEL: Record<LoadoutMode, string> = { role: 'Role default', custom: 'Custom' };

export const fmtTokens = (n: number) => n.toLocaleString('en-GB');

/** "~1,240 tokens per call (role default 3,900)"; the plain figure when nothing is narrowed. */
export function tokensLine(t: { current: number; roleDefault: number }): string {
  const base = `~${fmtTokens(t.current)} tokens per call`;
  return t.current === t.roleDefault ? `${base} (the role default)` : `${base} (role default ${fmtTokens(t.roleDefault)})`;
}

/** Share of the role default the loadout saves, 0–100; 0 when it is not smaller. */
export function savedPct(t: { current: number; roleDefault: number }): number {
  if (t.roleDefault <= 0 || t.current >= t.roleDefault) return 0;
  return Math.round(((t.roleDefault - t.current) / t.roleDefault) * 100);
}

export interface ToolGroup { kind: ToolKind; label: string; note: string; tools: LoadoutTool[]; enabled: number; tokens: number }

/** Tools grouped by kind in the fixed order read · act · terminal; empty groups are left out. */
export function groupTools(tools: LoadoutTool[]): ToolGroup[] {
  return KIND_ORDER
    .map((kind) => {
      const list = tools.filter((t) => t.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
      return {
        kind, ...KIND_LABEL[kind], tools: list,
        enabled: list.filter((t) => t.enabled).length,
        tokens: list.filter((t) => t.enabled).reduce((n, t) => n + t.tokens, 0),
      };
    })
    .filter((g) => g.tools.length > 0);
}

/** Why a tool's toggle is locked; null when the owner can flip it. */
export function lockReason(t: LoadoutTool): string | null {
  if (t.kind === 'terminal') return 'A terminal tool ends the run — it is always offered';
  if (t.core) return 'A core tool — every agent of this role needs it';
  if (!t.available) return 'Runs of this role always drop this tool, so switching it on changes nothing';
  return null;
}

/** "12 calls · 1 error · last used 2d ago", or "not used in 30 days". */
export function usageLine(t: Pick<LoadoutTool, 'calls30d' | 'errors30d' | 'lastUsedAt'>): string {
  if (!t.calls30d) return 'not used in 30 days';
  const calls = `${t.calls30d} ${t.calls30d === 1 ? 'call' : 'calls'}`;
  const errors = t.errors30d ? ` · ${t.errors30d} ${t.errors30d === 1 ? 'error' : 'errors'}` : '';
  return `${calls}${errors} · last used ${fmtRelative(t.lastUsedAt)}`;
}

/** The names a PUT sends after flipping one tool: every enabled tool, with `name` switched to `on`. */
export function toolsAfterToggle(tools: LoadoutTool[], name: string, on: boolean): string[] {
  return tools
    .filter((t) => (t.name === name ? on : t.enabled))
    .map((t) => t.name);
}

export interface SkillsSummary {
  total: number;
  enabled: number;
  inline: number;
  inlineChars: number;
  /** Enabled, not always-in-context skills nobody loaded in 30 days (they only cost a description line). */
  neverLoaded: string[];
}

export function skillsSummary(skills: LoadoutSkill[]): SkillsSummary {
  const on = skills.filter((s) => s.enabled);
  const inline = on.filter((s) => s.inline);
  return {
    total: skills.length,
    enabled: on.length,
    inline: inline.length,
    inlineChars: inline.reduce((n, s) => n + s.chars, 0),
    neverLoaded: on.filter((s) => !s.inline && s.loads30d === 0).map((s) => s.name).sort(),
  };
}

export interface RuleLine { key: 'ownerRules' | 'memory' | 'steeringSets' | 'playbookRules'; label: string; count: number; unit: string }

/** The four rule sources the channel gives its agents, with their counts. */
export function ruleLines(r: LoadoutRules): RuleLine[] {
  return [
    { key: 'ownerRules',    label: 'Owner rules',    count: r.ownerRules,    unit: r.ownerRules === 1 ? 'rule' : 'rules' },
    { key: 'memory',        label: 'Memory',         count: r.memory,        unit: r.memory === 1 ? 'entry' : 'entries' },
    { key: 'steeringSets',  label: 'Steering',       count: r.steeringSets,  unit: r.steeringSets === 1 ? 'active set' : 'active sets' },
    { key: 'playbookRules', label: 'Playbook rules', count: r.playbookRules, unit: r.playbookRules === 1 ? 'rule' : 'rules' },
  ];
}

/** Characters as a rough size: "~3.2k chars". */
export function fmtChars(n: number): string {
  return n >= 1000 ? `~${(n / 1000).toFixed(1)}k chars` : `${n} chars`;
}

const ERROR_TEXT: Record<string, string> = {
  core_tool: 'Core tools cannot be switched off',
  unknown_tool: 'That is not a tool of this agent\'s role',
  agent_not_found: 'The agent no longer exists',
};
export const loadoutErrorText = (code: string | undefined, fallback: string) => (code && ERROR_TEXT[code]) || fallback;
