import type { EditorRole } from '../llm/llm.types';
import type { EditorTool, ToolKind } from '../harness/tool';
import type { AgentSkillEntry } from '../agents/skill-store';
import type { LoadoutMode } from './loadout.repository';
import type { AgentUsage } from './loadout-usage';
import { coreOf, hardExcluded, roleDefaultOf, toolTokens, universeOf } from './loadout-profiles';

export interface ToolRowView {
  name:        string;
  kind:        ToolKind;
  description: string;
  /** Every agent of the role needs it: cannot be switched off (the terminal tools always pass). */
  core:        boolean;
  /** Offered to the agent's runs now. */
  enabled:     boolean;
  /** The agent's runs can use it (false: the role's runs always drop it, e.g. the writer's raw SQL). */
  available:   boolean;
  tokens:      number;
  calls30d:    number;
  errors30d:   number;
  lastUsedAt:  Date | null;
}

export interface SkillRowView {
  name:         string;
  scope:        string;
  enabled:      boolean;
  inline:       boolean;
  loads30d:     number;
  lastLoadedAt: Date | null;
  chars:        number;
}

/** The channel's rules the agent follows — they bind every agent on the channel and are not part of the loadout. */
export interface RulesView {
  ownerRules:    number;
  memory:        number;
  steeringSets:  number;
  playbookRules: number;
  chars:         number;
}

export interface LoadoutView {
  mode:        LoadoutMode;
  role:        EditorRole;
  tools:       ToolRowView[];
  skills:      SkillRowView[];
  rules:       RulesView;
  tokens:      { current: number; roleDefault: number };
  runs30d:     number;
  suggestions: unknown[];
}

const KIND_ORDER: Record<ToolKind, number> = { read: 0, act: 1, terminal: 2 };

export interface ViewInput {
  role:    EditorRole;
  mode:    LoadoutMode;
  /** The enabled names of a custom loadout (ignored in mode role). */
  enabled: string[];
  tools:   EditorTool[];
  usage:   AgentUsage;
  skills:  AgentSkillEntry[];
  rules:   RulesView;
  suggestions?: unknown[];
}

/** The effective tool names of a scheduled run for a mode and an enabled set (what `tokens.current` counts). */
export function effectiveTools(role: EditorRole, mode: LoadoutMode, enabled: string[], tools: EditorTool[]): EditorTool[] {
  const universe = universeOf(role, tools);
  const base = roleDefaultOf(role, universe);
  if (mode !== 'custom') return base;
  const on = new Set(enabled);
  return base.filter((t) => t.kind === 'terminal' || on.has(t.name));
}

export function buildLoadoutView(i: ViewInput): LoadoutView {
  const universe = universeOf(i.role, i.tools);
  const core = coreOf(i.role, universe);
  const out = hardExcluded(i.role, universe);
  const on = new Set(i.enabled);
  const rows: ToolRowView[] = universe.map((t) => {
    const use = i.usage.tools.get(t.name);
    const available = !out.has(t.name);
    return {
      name: t.name, kind: t.kind, description: t.description,
      core: core.has(t.name),
      enabled: available && (i.mode !== 'custom' || t.kind === 'terminal' || on.has(t.name)),
      available,
      tokens: toolTokens(t),
      calls30d: use?.calls ?? 0, errors30d: use?.errors ?? 0, lastUsedAt: use?.lastUsedAt ?? null,
    };
  }).sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));

  const tokenOf = new Map(rows.map((r) => [r.name, r.tokens]));
  const sum = (ts: Array<{ name: string }>) => ts.reduce((n, t) => n + (tokenOf.get(t.name) ?? 0), 0);
  const skills: SkillRowView[] = i.skills
    .filter((e) => e.skill.appliesTo.includes(i.role))
    .map((e) => {
      const l = i.usage.loads.get(e.skill.name);
      return {
        name: e.skill.name, scope: e.skill.scope, enabled: e.enabled, inline: e.inline,
        loads30d: l?.loads ?? 0, lastLoadedAt: l?.lastLoadedAt ?? null, chars: e.skill.body.length,
      };
    });
  return {
    mode: i.mode, role: i.role, tools: rows, skills, rules: i.rules,
    tokens: {
      current: sum(effectiveTools(i.role, i.mode, i.enabled, i.tools)),
      roleDefault: sum(roleDefaultOf(i.role, universe)),
    },
    runs30d: i.usage.runs,
    suggestions: i.suggestions ?? [],
  };
}
