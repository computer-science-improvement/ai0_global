/**
 * Spec 090 FR-001: one registry of owner gates. Every place where the system waits for the owner declares here what owner
 * silence does: `apply` (a reversible change goes ahead after the timeout, logged in `autonomy_decisions` with an undo),
 * `drop` (the proposal expires), or `wait` (it stays open; FR-009 human-only gates also get a weekly reminder).
 *
 * The registry is closed on purpose and pinned by `owner-gates.090.test.ts`: adding a gate or turning a `drop`/`wait` into
 * `apply` is a reviewed decision, not a local constant somewhere in a timeout path.
 *
 * `OWNER_SILENCE=wait` maps every `apply` back to the gate's `whenWait` (today's behaviour before 090), so the owner can
 * return to the old contract with one setting.
 */

export type SilenceAction = 'apply' | 'drop' | 'wait';
export type Env = (k: string) => string | undefined;

/** A number setting (inlined: the settings catalog imports this file, so it must stay free of service imports). */
function envNum(env: Env, key: string, def: number): number {
  const v = env(key)?.trim();
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}

export interface OwnerGate {
  /** Registry key. `<family>:<kind>`; a `<family>:*` entry is the fallback for kinds not listed. */
  key:         string;
  onSilence:   SilenceAction;
  /** What silence did before spec 090 (used under OWNER_SILENCE=wait). */
  whenWait:    'drop' | 'wait';
  /** The setting that holds the timeout in hours, and its default. Absent = event-driven (a readiness recheck, a probe). */
  hoursSetting?: string;
  defaultHours?: number;
  /** true only when an `autonomy_decisions.undo` can reverse it (FR-010). */
  reversible:  boolean;
  /** FR-009: never applied by code; the owner is reminded weekly. */
  humanOnly?:  true;
  /** One English line: what silence does (dashboard, help texts). */
  note:        string;
}

/** Spec 090 FR-002: directive kinds applied on silence by default (the `DIRECTIVE_TIMEOUT_APPLY_KINDS` catalog default). */
export const SILENCE_APPLY_DIRECTIVE_KINDS = [
  'frequency', 'format_mix', 'format_shift', 'voice_fix', 'task', 'pause_series', 'experiment', 'advice',
] as const;
/** Directive kinds that never apply on silence: they post to another owner's channel, rewrite the strategy, silence a channel, or repost. */
export const SILENCE_DROP_DIRECTIVE_KINDS = ['cross_promo', 'strategy', 'pause_resource', 'repost'] as const;

/** Spec 090 FR-003: pending-action kinds applied on silence (non-chat cards only; `change_source` also needs its guard). */
export const SILENCE_APPLY_ACTION_KINDS = ['change_source', 'edit_data_schema'] as const;

/** Spec 090 FR-006: audit fix kinds applied on silence. `series_resume` only for `pause_cause_gone` (the caller checks). */
export const SILENCE_APPLY_AUDIT_FIX_KINDS = [
  'memory_retire', 'tools_allow_add', 'hashtag_min_zero', 'series_resume', 'series_source_require', 'skill_inline_off',
] as const;
/** Audit fix kinds that keep waiting for the owner. */
export const SILENCE_WAIT_AUDIT_FIX_KINDS = ['conflicts_resolve', 'skill_disable', 'source_drop', 'host_proxy_add'] as const;

/** Spec 090 FR-009: the decisions that stay with the owner. */
export const HUMAN_ONLY_GATES = [
  'credential', 'bot_admin', 'budget_raise', 'mode_switch', 'post_approval', 'launch_start', 'cross_promo', 'network_mode',
  'strategy_migration', 'steering_set', 'network_offer',
] as const;

const DIR_H = { hoursSetting: 'DIRECTIVE_TIMEOUT_HOURS', defaultHours: 12 } as const;
const ACT_H = { hoursSetting: 'PENDING_ACTION_TTL_HOURS', defaultHours: 24 } as const;
const AUD_H = { hoursSetting: 'AUDIT_AUTO_FIX_HOURS', defaultHours: 24 } as const;

function human(key: string, note: string): OwnerGate {
  return { key, onSilence: 'wait', whenWait: 'wait', reversible: false, humanOnly: true, note };
}

export const OWNER_GATES: readonly OwnerGate[] = [
  // Pauses (FR-005).
  { key: 'series_pause:no_material', onSilence: 'apply', whenWait: 'wait', hoursSetting: 'SERIES_PAUSE_RETRY_HOURS', defaultHours: 24, reversible: true,
    note: 'A series paused for having nothing to post is resumed after the retry window.' },
  { key: 'series_pause:source_unreachable', onSilence: 'apply', whenWait: 'wait', reversible: true,
    note: 'A series paused for an unreadable source is resumed once readiness sees the source work again.' },
  { key: 'series_pause:owner', onSilence: 'wait', whenWait: 'wait', reversible: false, note: 'Your own pauses are never lifted by the system.' },

  // Directives (FR-002).
  ...SILENCE_APPLY_DIRECTIVE_KINDS.map((k): OwnerGate => ({ key: `directive:${k}`, onSilence: 'apply', whenWait: 'drop', ...DIR_H, reversible: true,
    note: `A ${k} directive with no answer is applied after the timeout.` })),
  ...SILENCE_DROP_DIRECTIVE_KINDS.map((k): OwnerGate => ({ key: `directive:${k}`, onSilence: 'drop', whenWait: 'drop', ...DIR_H, reversible: false,
    note: `A ${k} directive with no answer expires after the timeout.` })),
  { key: 'directive_contest', onSilence: 'drop', whenWait: 'drop', hoursSetting: 'DIRECTIVE_CONTEST_TIMEOUT_HOURS', defaultHours: 24, reversible: false,
    note: 'A contested directive with no answer: the refusal stands.' },

  // Pending actions (FR-003). Chat cards always drop; the caller checks `chat_id` before asking the registry.
  ...SILENCE_APPLY_ACTION_KINDS.map((k): OwnerGate => ({ key: `pending_action:${k}`, onSilence: 'apply', whenWait: 'drop', ...ACT_H, reversible: true,
    note: `A ${k} card nobody answered is applied after the timeout (not from a chat).` })),
  { key: 'pending_action:chat', onSilence: 'drop', whenWait: 'drop', ...ACT_H, reversible: false, note: 'A card from a chat expires: you saw it and chose not to apply it.' },
  { key: 'pending_action:*', onSilence: 'drop', whenWait: 'drop', ...ACT_H, reversible: false, note: 'Other cards expire after the timeout.' },

  // Playbooks (FR-004).
  { key: 'playbook', onSilence: 'apply', whenWait: 'wait', hoursSetting: 'PLAYBOOK_PENDING_HOURS', defaultHours: 48, reversible: true,
    note: 'A playbook version waiting for you becomes active after the timeout unless it is structural.' },
  { key: 'playbook:structural', onSilence: 'wait', whenWait: 'wait', reversible: false,
    note: 'A playbook version that changes locked or owner series, platforms or owner rules waits for you.' },

  // Setup proposals (FR-007).
  { key: 'setup_proposal', onSilence: 'apply', whenWait: 'drop', hoursSetting: 'SETUP_PROPOSAL_APPLY_HOURS', defaultHours: 72, reversible: true,
    note: 'The safe sections of a setup proposal are applied after the timeout; the rest expire.' },

  // Audit and readiness fixes (FR-005, FR-006).
  ...SILENCE_APPLY_AUDIT_FIX_KINDS.map((k): OwnerGate => ({ key: `audit_fix:${k}`, onSilence: 'apply', whenWait: 'wait', ...AUD_H, reversible: true,
    note: `The ${k} fix is applied after the timeout.` })),
  ...SILENCE_WAIT_AUDIT_FIX_KINDS.map((k): OwnerGate => ({ key: `audit_fix:${k}`, onSilence: 'wait', whenWait: 'wait', reversible: false,
    note: `The ${k} fix waits for you.` })),
  { key: 'readiness_fix:series_resume', onSilence: 'apply', whenWait: 'wait', reversible: true,
    note: 'A pause whose cause is gone is lifted at the next readiness check.' },

  // Launch (FR-008).
  { key: 'launch_graduation', onSilence: 'apply', whenWait: 'wait', reversible: true,
    note: 'A launched channel that meets the criteria goes live by itself (held by readiness blockers).' },

  // Spec 091 FR-005: a dark channel is recovered by code (a forced planner run, an evergreen post); logged, not reversible.
  { key: 'slo_recovery', onSilence: 'apply', whenWait: 'wait', hoursSetting: 'SLO_DARK_HOURS', defaultHours: 24, reversible: false,
    note: 'A live channel with no post for the dark window gets a recovery planner run (and an evergreen post) without waiting for you.' },

  // Human-only (FR-009).
  human('credential', 'Tokens and connections need you.'),
  human('bot_admin', 'Bot admin rights need you.'),
  human('budget_raise', 'Raising a budget needs you.'),
  human('mode_switch', 'Switching a channel mode needs you.'),
  human('post_approval', 'In approval mode a post needs your approval; an unapproved one expires.'),
  human('launch_start', 'Starting a launch needs you.'),
  human('cross_promo', 'Cross-promotion with another owner needs you.'),
  human('network_mode', 'Changing the network mode needs you.'),
  human('strategy_migration', 'Strategy migrations need you.'),
  human('steering_set', 'Steering sets need you.'),
  human('network_offer', 'Network offers need you.'),
];

const BY_KEY = new Map(OWNER_GATES.map((g) => [g.key, g]));

/** The gate for a key: the exact entry, else the `<family>:*` fallback. Throws on an unknown key (a code bug, not data). */
export function gateFor(key: string): OwnerGate {
  const exact = BY_KEY.get(key);
  if (exact) return exact;
  const fam = key.includes(':') ? `${key.slice(0, key.indexOf(':'))}:*` : '';
  const fallback = fam ? BY_KEY.get(fam) : undefined;
  if (fallback) return fallback;
  throw new Error(`unknown owner gate ${key}`);
}

/** OWNER_SILENCE: `act` (the registry) or `wait` (pre-090 behaviour). Anything else reads as `act`. */
export function ownerSilenceMode(env: Env): 'act' | 'wait' {
  return (env('OWNER_SILENCE') ?? '').trim().toLowerCase() === 'wait' ? 'wait' : 'act';
}

/** What silence does for a gate now. */
export function silenceFor(key: string, env: Env): SilenceAction {
  const g = gateFor(key);
  if (g.onSilence === 'apply' && ownerSilenceMode(env) === 'wait') return g.whenWait;
  return g.onSilence;
}

/** The gate's timeout in hours (its setting, else its default). null for an event-driven gate. 0 means "off" (wait). */
export function gateHours(key: string, env: Env): number | null {
  const g = gateFor(key);
  if (!g.hoursSetting) return null;
  return Math.max(0, envNum(env, g.hoursSetting, g.defaultHours ?? 0));
}

/** True when a gate opened at `openedAt` has timed out at `now` and silence should `apply` (a 0-hour setting never applies). */
export function silenceApplies(key: string, env: Env, openedAt: Date, now: Date): boolean {
  if (silenceFor(key, env) !== 'apply') return false;
  const h = gateHours(key, env);
  if (h === null) return true;
  if (h <= 0) return false;
  return now.getTime() - openedAt.getTime() >= h * 3_600_000;
}

/** The registry key for a pending action: chat cards share one gate (always drop). */
export function pendingActionGate(a: { kind: string; chatId: string | null }): string {
  return a.chatId ? 'pending_action:chat' : `pending_action:${a.kind}`;
}
