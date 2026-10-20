// Loadout suggestions (spec 054 FR-005): what an agent's tool set is missing, what it never uses. Pure: the last
// 30 days of usage in, a list out. Counted in code, no LLM.

import type { EditorRole } from '../llm/llm.types';
import type { EditorTool } from '../harness/tool';
import type { AgentSkillEntry } from '../agents/skill-store';
import { isOptionalSkill, isProtectedSkill } from '../skills/skill-library';
import type { LoadoutMode } from './loadout.repository';
import type { AgentUsage, PeerRates } from './loadout-usage';
import { PEER_MIN_RUNS } from './loadout-profiles';

export type SuggestionKind = 'unused' | 'missing' | 'peer' | 'stale' | 'skills_unused';
export type SuggestionAction = 'add' | 'remove' | 'disable';

export interface LoadoutSuggestion {
  /** Stable for the same finding: `<kind>:<tool|skill>`. */
  id:       string;
  kind:     SuggestionKind;
  tool?:    string;
  skill?:   string;
  action:   SuggestionAction;
  /** English, one line. */
  reason:   string;
  /** The counts the finding rests on. */
  evidence: Record<string, number>;
}

/** A tool offered in this many runs without one call is a candidate to remove. */
export const UNUSED_MIN_OFFERED = 10;
/** Refused calls to a tool the agent was not offered before it is a candidate to add. */
export const MISSING_MIN_DENIED = 2;
/** Share of peer runs that call a tool before it is suggested. */
export const PEER_SUGGEST_RATE = 0.3;
/** Runs of the agent before an unloaded skill is called unused. */
export const SKILL_MIN_RUNS = 10;

const KIND_ORDER: Record<SuggestionKind, number> = { missing: 0, peer: 1, unused: 2, stale: 3, skills_unused: 4 };

export interface SuggestionInput {
  role:      EditorRole;
  mode:      LoadoutMode;
  /** Raw enabled names of a custom loadout (may hold names that no longer exist). */
  enabled:   string[];
  /** The role's tools, with who may use them. */
  universe:  Array<Pick<EditorTool, 'name' | 'kind'>>;
  core:      Set<string>;
  /** Tools runs of the role always drop. */
  hardOut:   Set<string>;
  usage:     AgentUsage;
  peers?:    PeerRates | null;
  skills:    AgentSkillEntry[];
}

/** Skills whose text is already in the prompt (or applied by the runner), so a missing `load_skill` says nothing. */
export function skillInPrompt(name: string, role: EditorRole): boolean {
  return name === `editor-${role}-workflow` || name.endsWith('-workflow') || name === 'voice-core' || name.startsWith('agent-') || isOptionalSkill(name) || isProtectedSkill(name);
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const times = (n: number) => `${n} ${n === 1 ? 'time' : 'times'}`;

export function loadoutSuggestions(i: SuggestionInput): LoadoutSuggestion[] {
  const out: LoadoutSuggestion[] = [];
  const known = new Map(i.universe.map((t) => [t.name, t]));
  const raw = new Set(i.enabled);
  const isOn = (name: string) => {
    const t = known.get(name);
    if (!t || i.hardOut.has(name)) return false;
    return i.mode !== 'custom' || t.kind === 'terminal' || raw.has(name);
  };
  const optional = (name: string) => {
    const t = known.get(name);
    return !!t && t.kind !== 'terminal' && !i.core.has(name) && !i.hardOut.has(name);
  };
  const add = (s: LoadoutSuggestion) => { out.push(s); };

  // missing: the agent called a tool it was not offered.
  const missing = new Set<string>();
  for (const [tool, denied] of i.usage.denied) {
    if (denied < MISSING_MIN_DENIED || !optional(tool) || isOn(tool)) continue;
    missing.add(tool);
    add({
      id: `missing:${tool}`, kind: 'missing', tool, action: 'add',
      reason: `Tried to call ${tool} ${times(denied)} in 30 days, but it is not offered`, evidence: { denied },
    });
  }

  // peer: agents of the same role call it often; this one lacks it.
  const peers = i.peers;
  if (peers && peers.runs >= PEER_MIN_RUNS) {
    for (const [tool, rate] of peers.rates) {
      if (rate < PEER_SUGGEST_RATE || missing.has(tool) || !optional(tool) || isOn(tool)) continue;
      add({
        id: `peer:${tool}`, kind: 'peer', tool, action: 'add',
        reason: `Other ${i.role} agents call ${tool} in ${pct(rate)} of their runs; this one does not have it`,
        evidence: { peerRuns: peers.runs, peerPct: Math.round(rate * 100) },
      });
    }
  }

  // unused: offered often, never called.
  for (const t of i.universe) {
    if (!optional(t.name) || !isOn(t.name)) continue;
    const offered = i.usage.offered.get(t.name) ?? 0;
    if (offered < UNUSED_MIN_OFFERED || (i.usage.tools.get(t.name)?.calls ?? 0) > 0) continue;
    add({
      id: `unused:${t.name}`, kind: 'unused', tool: t.name, action: 'remove',
      reason: `Offered in ${offered} runs in 30 days and never called`, evidence: { offered, calls: 0 },
    });
  }

  // stale: a stored name that is no longer a tool of the role.
  if (i.mode === 'custom') {
    for (const name of [...raw].sort()) {
      if (known.has(name)) continue;
      add({
        id: `stale:${name}`, kind: 'stale', tool: name, action: 'remove',
        reason: `${name} is no longer a tool of the ${i.role} role; the stored name is ignored`, evidence: {},
      });
    }
  }

  // skills_unused: an on-demand skill nobody loaded.
  if (i.usage.runs >= SKILL_MIN_RUNS) {
    for (const e of i.skills) {
      const s = e.skill;
      if (!e.enabled || e.inline || s.safety || skillInPrompt(s.name, i.role)) continue;
      if ((i.usage.loads.get(s.name)?.loads ?? 0) > 0) continue;
      add({
        id: `skills_unused:${s.name}`, kind: 'skills_unused', skill: s.name, action: 'disable',
        reason: `Skill ${s.name} was not loaded in ${i.usage.runs} runs in 30 days; it only costs a description line`,
        evidence: { runs: i.usage.runs, loads: 0 },
      });
    }
  }

  return out.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.tool ?? a.skill ?? '').localeCompare(b.tool ?? b.skill ?? ''));
}

/** What a "Use recommended" applies: the tool and skill findings split by action. */
export function splitApply(list: LoadoutSuggestion[]): { add: string[]; remove: string[]; disableSkills: string[] } {
  return {
    add: list.filter((s) => s.action === 'add' && s.tool).map((s) => s.tool!),
    remove: list.filter((s) => s.action === 'remove' && s.tool).map((s) => s.tool!),
    disableSkills: list.filter((s) => s.action === 'disable' && s.skill).map((s) => s.skill!),
  };
}
