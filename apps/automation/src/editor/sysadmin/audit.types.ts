/**
 * Spec 055 FR-001: the sysadmin's findings. The checks are pure functions over `AuditFacts` (loaded by
 * audit-queries.ts); each returns findings with the evidence behind them and, when the problem has a closed-list
 * remedy, the fix the owner can apply in one click.
 */

export const AUDIT_AREAS = ['skills', 'memory', 'rules', 'tools', 'prompt'] as const;
export type AuditArea = typeof AUDIT_AREAS[number];
export const AUDIT_SEVERITIES = ['info', 'warn', 'error'] as const;
export type AuditSeverity = typeof AUDIT_SEVERITIES[number];
export const SUBJECT_TYPES = ['skill', 'memory', 'rule', 'steering', 'playbook', 'agent', 'tool', 'channel'] as const;
export type SubjectType = typeof SUBJECT_TYPES[number];

export interface FindingSubject {
  type:     SubjectType;
  id:       string;
  label:    string;
  /** The agent handle the finding is about (without "@"). */
  agent?:   string;
  /** The Telegram channel key (`@name`) the finding is about. */
  channel?: string;
}

/** The closed list of fixes (FR-003): each one maps to an existing service call; nothing else is ever applied. */
export type Fix =
  | { kind: 'skill_disable';     agent: string; skill: string }
  | { kind: 'skill_inline_off';  agent: string; skill: string }
  | { kind: 'memory_retire';     channel: string; id: number }
  | { kind: 'conflicts_resolve'; agent: string };
export type FixKind = Fix['kind'];
export const FIX_KINDS: readonly FixKind[] = ['skill_disable', 'skill_inline_off', 'memory_retire', 'conflicts_resolve'];

export interface Finding {
  /** A stable hash of area + check + subject: the same problem has the same key every week. */
  key:      string;
  area:     AuditArea;
  /** The check that found it (`skill_lint`, `memory_duplicate`…). */
  check:    string;
  severity: AuditSeverity;
  subject:  FindingSubject;
  title:    string;
  detail:   string;
  evidence: Record<string, unknown>;
  fix?:     Fix;
}

// ── facts ───────────────────────────────────────────────────────────────────

/** A skill of the database (any scope). */
export interface SkillFact {
  id:          string;
  name:        string;
  scope:       'builtin' | 'global' | 'agent';
  /** Handle of the owning agent (agent scope). */
  agent:       string | null;
  description: string;
  appliesTo:   string[];
  body:        string;
  safety:      boolean;
  locked:      boolean;
}

/** A skill as one agent sees it (SkillStore.listForAgent). */
export interface AgentSkillFact {
  skillId:     string;
  name:        string;
  origin:      'builtin' | 'global' | 'override' | 'own' | 'inherited';
  enabled:     boolean;
  inline:      boolean;
  description: string;
  appliesTo:   string[];
  body:        string;
  safety:      boolean;
  updatedAt:   Date;
}

/** A top-level agent with its children's activity folded in (a role child inherits its orchestrator's skills). */
export interface AgentFact {
  id:        string;
  handle:    string;
  kind:      string;
  /** Runs of the agent and its children in the window. */
  runs:      number;
  /** Roles those runs were made in. */
  roles:     string[];
  /** `load_skill` calls by skill name in the window. */
  loads:     Record<string, number>;
  skills:    AgentSkillFact[];
}

export interface RollbackFact { skillId: string; name: string; agent: string | null; count: number }

export interface MemoryFact {
  id:        number;
  channel:   string;
  kind:      'insight' | 'rule' | 'avoid';
  text:      string;
  createdBy: 'reviewer' | 'owner';
  createdAt: Date;
  /** `evidence.source` (`approval` = an owner preference learnt on approval, shown in its own prompt section). */
  source:    string | null;
}

export interface RuleFact {
  id:      number;
  channel: string;
  agent:   string | null;
  text:    string;
  issues:  Array<{ code: string; detail: string }>;
}

export interface ConflictFact { code: string; ref: string; detail: string; ruleId: number | null }
export interface AgentConflictsFact { agent: string; channel: string | null; conflicts: ConflictFact[] }

export interface PlaybookFact {
  agent:    string;
  channel:  string | null;
  version:  number;
  errors:   string[];
  warnings: Array<{ code: string; ref: string; text: string }>;
}

export interface SteeringFact {
  id:           string;
  target:       string;
  channel:      string | null;
  source:       string;
  status:       string;
  enabledRules: number;
  channelExists: boolean;
}

export interface ToolStatFact { tool: string; calls: number; errors: number; topErrors: Array<{ text: string; count: number }> }
export interface RoleRunFact { role: string; runs: number; bad: number }

export interface AuditFacts {
  now:        Date;
  /** The tool names that exist (the ToolRegistry); empty = the unknown-tool check is skipped. */
  knownTools: ReadonlySet<string>;
  skills:     SkillFact[];
  agents:     AgentFact[];
  rollbacks:  RollbackFact[];
  memory:     MemoryFact[];
  rules:      RuleFact[];
  conflicts:  AgentConflictsFact[];
  playbooks:  PlaybookFact[];
  steering:   SteeringFact[];
  toolStats:  ToolStatFact[];
  roleRuns:   RoleRunFact[];
}

export const emptyFacts = (now = new Date()): AuditFacts => ({
  now, knownTools: new Set(), skills: [], agents: [], rollbacks: [], memory: [], rules: [], conflicts: [], playbooks: [],
  steering: [], toolStats: [], roleRuns: [],
});

// ── thresholds (one place, tests read them) ─────────────────────────────────

export const AUDIT_LIMITS = {
  /** Skills never loaded: the agent group ran at least this many times in the window. */
  unusedMinRuns:     10,
  unusedDays:        30,
  skillDuplicateSim: 0.85,
  /** Bodies shorter than this many tokens are too small to call duplicates. */
  duplicateMinTokens: 20,
  rollbackCount:     2,
  rollbackDays:      60,
  memoryPromptCap:   30,
  memoryWriterCap:   15,
  memoryDuplicateSim: 0.8,
  staleInsightDays:  90,
  /** A later row confirms an insight when it shares this much of its words. */
  confirmSim:        0.4,
  toolErrorRate:     0.2,
  toolMinCalls:      5,
  roleBadRate:       0.15,
  roleMinRuns:       5,
  toolWindowDays:    7,
  inlineBudget:      8_000,
  /** One check never fills the report with more than this many findings; the rest become one "more like this" line. */
  maxPerCheck:       25,
} as const;
