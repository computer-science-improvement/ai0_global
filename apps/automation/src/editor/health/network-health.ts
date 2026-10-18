import type { SourceHealth } from '../sources/source-health';
import type { AgentCapStatus, BudgetState, BudgetStatus, BlockingCap } from '../../spend/spend.service';

/**
 * Spec 049 FR-005: the network's health in one place — connections, sources, budget headroom and stuck work.
 * Pure: the service reads the rows, this sorts them, counts the problems and renders the English text section the
 * weekly owner report (spec 012) takes as it is.
 */

/** Connection states that stop or threaten publishing (the daily reminders of spec 049 FR-001 use the same set). */
export const BAD_CONNECTION_STATES = ['no_access', 'token_invalid', 'token_expiring', 'rate_limited'] as const;
export type BadConnectionState = typeof BAD_CONNECTION_STATES[number];

export interface ConnectionIssue {
  ref:       string;
  title:     string | null;
  state:     BadConnectionState;
  detail:    string | null;
  /** When the resource entered this state. */
  since:     string | null;
  checkedAt: string | null;
  expiresAt: string | null;
  /** The owner muted the daily reminders. */
  muted:     boolean;
  agent:     string | null;
}

export interface SourceIssue extends SourceHealth {
  channelKey: string;
  agent:      string | null;
}

export interface BudgetLine {
  label:    string;
  spentUsd: number;
  capUsd:   number;
  pct:      number;
  state:    BudgetState;
  enforce:  boolean;
}

export interface BudgetSection {
  /** The total, agents and chat caps first, then the other daily caps, then per-agent caps at 70 % or more. */
  lines:     BudgetLine[];
  /** Caps that block calls now. */
  blocking:  BlockingCap[];
  /** Slots that waited for or were skipped by a cap today. */
  slotsHit:  number;
}

export type StuckKind = 'slot_running' | 'slot_overdue' | 'slot_failed' | 'approval_waiting' | 'action_waiting' | 'playbook_waiting' | 'ideas_waiting';

export interface StuckItem {
  id:          string;
  title:       string;
  at:          string;
  channelKey?: string | null;
  agent?:      string | null;
  detail?:     string | null;
}

export interface StuckGroup {
  kind:     StuckKind;
  label:    string;
  /** What "stuck" means for this kind (shown under the label). */
  rule:     string;
  count:    number;
  oldestAt: string | null;
  /** The first items, oldest first. */
  items:    StuckItem[];
}

export interface NetworkHealth {
  generatedAt: string;
  connections: ConnectionIssue[];
  sources:     SourceIssue[];
  budget:      BudgetSection;
  stuck:       StuckGroup[];
  /** Problems across the four sections (0 = all clear). */
  problems:    number;
}

/** Thresholds of "stuck" (owner-facing; the rule line of each group says them). */
export const STUCK_RULES: Record<StuckKind, { label: string; rule: string }> = {
  slot_running:     { label: 'Posts stuck in a run',        rule: 'running for over 30 min' },
  slot_overdue:     { label: 'Overdue posts',               rule: 'planned, 30 min past their time and not waiting for a retry' },
  slot_failed:      { label: 'Failed posts',                rule: 'failed in the last 24 h' },
  approval_waiting: { label: 'Posts waiting for approval',  rule: 'waiting over 24 h' },
  action_waiting:   { label: 'Cards waiting for you',       rule: 'Apply / Discard cards waiting over 12 h' },
  playbook_waiting: { label: 'Playbooks waiting for you',   rule: 'waiting over 2 days' },
  ideas_waiting:    { label: 'Ideas nobody reviewed',       rule: 'new for over 48 h' },
};

export const STUCK_ORDER: StuckKind[] = ['slot_running', 'slot_failed', 'slot_overdue', 'approval_waiting', 'action_waiting', 'playbook_waiting', 'ideas_waiting'];

const CONNECTION_ORDER: Record<BadConnectionState, number> = { token_invalid: 0, no_access: 1, rate_limited: 2, token_expiring: 3 };
const SOURCE_ORDER: Record<string, number> = { blocked: 0, failing: 1, exhausted: 2 };
const BUDGET_ATTENTION: BudgetState[] = ['warning', 'danger', 'over', 'blocked'];

/** The budget lines worth showing: the three main caps always, other caps with a daily limit, agents near theirs. */
export function budgetLines(rows: BudgetStatus[], agentCaps: AgentCapStatus[]): BudgetLine[] {
  const rank = (b: BudgetStatus) => (b.scopeKind === 'global' ? 0 : b.scopeKey === 'editor.' ? 1 : b.scopeKey === 'editor.chat' ? 2 : 3);
  const caps = rows.filter((b) => b.dailyUsd != null)
    .sort((a, b) => rank(a) - rank(b) || (b.pct ?? 0) - (a.pct ?? 0))
    .map((b) => ({ label: b.label, spentUsd: b.spentTodayUsd, capUsd: b.dailyUsd!, pct: b.pct ?? 0, state: b.state, enforce: b.enforce }));
  const agents = agentCaps.filter((a) => BUDGET_ATTENTION.includes(a.state))
    .sort((a, b) => b.pct - a.pct)
    .map((a) => ({ label: `Agent @${a.handle}`, spentUsd: a.spentUsd, capUsd: a.capUsd, pct: a.pct, state: a.state, enforce: true }));
  return [...caps, ...agents];
}

/** Assembles the view: worst first in every section, empty stuck groups dropped, problems counted. */
export function networkHealth(p: {
  now: Date; connections: ConnectionIssue[]; sources: SourceIssue[];
  budget: { rows: BudgetStatus[]; agentCaps: AgentCapStatus[]; blocking: BlockingCap[]; slotsHit: number };
  stuck: Array<Omit<StuckGroup, 'label' | 'rule'>>;
}): NetworkHealth {
  const connections = [...p.connections].sort((a, b) => CONNECTION_ORDER[a.state] - CONNECTION_ORDER[b.state] || a.ref.localeCompare(b.ref));
  const sources = [...p.sources].sort((a, b) => (SOURCE_ORDER[a.state] ?? 9) - (SOURCE_ORDER[b.state] ?? 9) || b.slotsLost - a.slotsLost || b.errors - a.errors);
  const lines = budgetLines(p.budget.rows, p.budget.agentCaps);
  const stuck = p.stuck.filter((g) => g.count > 0)
    .sort((a, b) => STUCK_ORDER.indexOf(a.kind) - STUCK_ORDER.indexOf(b.kind))
    .map((g) => ({ ...g, ...STUCK_RULES[g.kind] }));
  const budgetProblems = lines.filter((l) => BUDGET_ATTENTION.includes(l.state)).length;
  return {
    generatedAt: p.now.toISOString(),
    connections, sources,
    budget: { lines, blocking: p.budget.blocking, slotsHit: p.budget.slotsHit },
    stuck,
    problems: connections.length + sources.length + budgetProblems + stuck.reduce((s, g) => s + g.count, 0),
  };
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const CONNECTION_TEXT: Record<BadConnectionState, string> = {
  token_invalid: 'token does not work', no_access: 'no access', rate_limited: 'rate-limited', token_expiring: 'token expires soon',
};
const SOURCE_TEXT: Record<string, string> = { blocked: 'blocked', failing: 'failing', exhausted: 'nothing new' };

/**
 * The "Network health" section of the weekly owner report (spec 012 renders the report; this is its section).
 * Plain English text, one line per problem, at most `max` lines per part.
 */
export function healthReportSection(h: NetworkHealth, max = 5): string {
  const out: string[] = ['Network health'];
  if (!h.problems) return [...out, 'All clear: connections work, sources answer, budgets have room, nothing is stuck.'].join('\n');
  const part = <T>(title: string, rows: T[], line: (r: T) => string) => {
    if (!rows.length) return;
    out.push('', `${title} (${rows.length})`);
    for (const r of rows.slice(0, max)) out.push(`- ${line(r)}`);
    if (rows.length > max) out.push(`- and ${rows.length - max} more`);
  };
  part('Connections', h.connections, (c) => `${c.title ? `${c.title} (${c.ref})` : c.ref}: ${CONNECTION_TEXT[c.state]}${c.detail ? ` — ${c.detail}` : ''}${c.muted ? ' (reminders muted)' : ''}`);
  part('Sources', h.sources, (s) => `${s.channelKey} «${s.id}» (${s.kind}): ${SOURCE_TEXT[s.state] ?? s.state} — ${s.detail}`);
  const tight = h.budget.lines.filter((l) => BUDGET_ATTENTION.includes(l.state));
  part('Budget', tight, (l) => `${l.label}: ${usd(l.spentUsd)} of ${usd(l.capUsd)} today (${Math.round(l.pct)} %)${l.state === 'blocked' ? ', blocking calls' : ''}`);
  if (h.budget.slotsHit) {
    if (!tight.length) out.push('', 'Budget');
    out.push(`- ${h.budget.slotsHit} post${h.budget.slotsHit === 1 ? '' : 's'} waited for or skipped by a cap today`);
  }
  part('Stuck work', h.stuck, (g) => `${g.label}: ${g.count} (${g.rule})`);
  return out.join('\n');
}
