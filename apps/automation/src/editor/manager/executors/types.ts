import type { Agent } from '../../agents/agent.types';
import type { ChannelMode, EditorCard } from '../../card';
import type { NetworkCtx } from '../../network/network-context';
import type { Playbook } from '../../network/playbook';
import type { Directive, DirectiveKind } from '../directives.repository';

/**
 * Executor framework (spec 025 FR-009): every directive kind with code behind it has
 *   plan(dir, ctx)  → the concrete change (a dry-run at filing, the real one after acceptance) or an error;
 *   apply(change)   → writes it (idempotent: a change that already holds is a no-op);
 *   verify(dir)     → was it observed in plans / publishing?
 * `applied` means the change exists; `verified` means it was observed (constitution I and IX).
 */

/** What an executor knows about the target orchestrator (built per call; never cached across runs). */
export interface ExecContext {
  orch:      Agent;
  /** The orchestrator's anchor card (Telegram); null when it has none (then nothing is executable). */
  card:      EditorCard | null;
  net:       NetworkCtx | null;
  /** The active playbook body (normalized), or null — single-channel orchestrators then edit their card. */
  playbook:  Playbook | null;
  /** The effective mode (orchestrator ∧ card) the classification runs in (spec 031). */
  mode?:     ChannelMode;
  /** Spec 025 FR-013: the active resource pauses (ref → until), when the context was built with them. */
  pauses?:   Array<{ ref: string; until: Date }>;
  now:       Date;
}

export interface PerDay { min: number; max: number }

/** One concrete edit. `target` says where it lands: a playbook version or the single-channel card. */
export type ChangeOp =
  | { op: 'per_day'; resource_ref: string; before: PerDay; after: PerDay }
  | { op: 'format_weight'; resource_ref: string; format: string; before: number; after: number }
  | { op: 'series_active'; series: string; before: boolean; after: boolean; resume_on?: string }
  /** Spec 025 FR-013: a resource_pauses row; `until` is an ISO timestamp. */
  | { op: 'pause_resource'; resource_ref: string; days: number; until: string; reason: string };

export type Change = ChangeOp & {
  kind:        DirectiveKind;
  target:      'playbook' | 'card' | 'resource';
  /** The card the change lands on (target 'card') — the orchestrator's Telegram anchor. */
  channel_key?: string;
  /** Dry-run classification (classifyPlaybookChange): a format added, per_day ≥ ±30 %, approval-mode schedule changes. */
  structural:  boolean;
  reasons:     string[];
  /** Set by applying (playbook target): the version the executor wrote, or the one that already held it. */
  playbook_id?: string;
  version?:    number;
  noop?:       boolean;
  /** pause_series: when housekeeping wrote the resuming version. */
  resumed_at?: string;
};

/**
 * Spec 025 FR-014: an experiment quota — `slots` planned slots with `directive_id` on `resource_ref` by `deadline`.
 * Nothing is written when it opens: the plan validators read open quotas (status accepted/applied, deadline ahead).
 */
export interface ExperimentChange {
  kind:         'experiment';
  op:           'experiment';
  target:       'quota';
  /** The anchor whose day plans hold the slots (network plans live on the anchor). */
  channel_key:  string;
  resource_ref: string;
  angle:        string;
  format:       string | null;
  slots:        number;
  within_days:  number;
  /** ISO instant: acceptance + within_days. A quota still open then → failed. */
  deadline:     string;
  structural:   false;
  reasons:      string[];
  noop?:        boolean;
}

/** Spec 025 FR-015: a strategy rebuilds the playbook from the directive's brief; the owner activates the version. */
export interface StrategyChange {
  kind:        'strategy';
  op:          'playbook_build';
  target:      'owner';
  channel_key: string;
  brief:       string;
  structural:  true;
  reasons:     string[];
  /** The pending_owner version the build wrote (set once it exists). */
  playbook_id?: string;
  version?:    number;
  /** Set when the owner activated the version (NetworkService.decide). */
  activated_at?: string;
  noop?:       boolean;
}

/** Every change an executor can plan. Playbook kinds keep `Change`; the T5 kinds have their own shapes. */
export type AnyChange = Change | ExperimentChange | StrategyChange;

export type PlanError = { error: 'not_executable'; details: string };
export type PlanResult<C = AnyChange> = C | PlanError;

/**
 * `pending` — nothing failed, but the change does not exist yet (an experiment quota with no slot planned, a
 * strategy version waiting for the owner): the directive stays `accepted` and is checked again hourly.
 * `ownerRejected` — the owner rejected the directive's playbook version (strategy): the directive is rejected.
 */
export interface Applied { noop: boolean; playbookId?: string; version?: number; pending?: boolean; ownerRejected?: boolean }

export type Adherence = 'followed' | 'violated' | 'not_followed';

/** `pending` — nothing to observe yet (no plan after applied_at); try again next hour. */
export type VerifyResult =
  | { pending: true; detail?: Record<string, unknown> }
  | { pending?: false; verified: boolean; adherence: Adherence; detail: Record<string, unknown> };

export interface DirectiveExecutor<C extends { kind: DirectiveKind; structural: boolean; reasons: string[] } = Change> {
  kind:   DirectiveKind;
  plan(dir: Pick<Directive, 'kind' | 'params' | 'toAgentId'> & { id?: string; body?: string }, ctx: ExecContext): PlanResult<C>;
  apply(change: C, dir: Pick<Directive, 'id' | 'toAgentId' | 'kind'>): Promise<Applied>;
  verify(dir: Directive): Promise<VerifyResult>;
}

/** Any executor (the registry holds playbook, experiment and strategy executors side by side). */
export type AnyExecutor = DirectiveExecutor<any>;

/** A kind with code that observes it but no plan/apply of its own (spec 025: promo kinds, applied by PromoPlanner). */
export interface DirectiveVerifier {
  kind:   DirectiveKind;
  verify(dir: Directive): Promise<VerifyResult>;
}

export const isPlanError = (x: PlanResult<unknown> | null | undefined): x is PlanError => !!x && typeof x === 'object' && 'error' in x;
