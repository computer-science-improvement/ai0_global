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
  now:       Date;
}

export interface PerDay { min: number; max: number }

/** One concrete edit. `target` says where it lands: a playbook version or the single-channel card. */
export type ChangeOp =
  | { op: 'per_day'; resource_ref: string; before: PerDay; after: PerDay }
  | { op: 'format_weight'; resource_ref: string; format: string; before: number; after: number }
  | { op: 'series_active'; series: string; before: boolean; after: boolean; resume_on?: string };

export type Change = ChangeOp & {
  kind:        DirectiveKind;
  target:      'playbook' | 'card';
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

export type PlanError = { error: 'not_executable'; details: string };
export type PlanResult = Change | PlanError;

export interface Applied { noop: boolean; playbookId?: string; version?: number }

export type Adherence = 'followed' | 'violated' | 'not_followed';

/** `pending` — nothing to observe yet (no plan after applied_at); try again next hour. */
export type VerifyResult =
  | { pending: true; detail?: Record<string, unknown> }
  | { pending?: false; verified: boolean; adherence: Adherence; detail: Record<string, unknown> };

export interface DirectiveExecutor {
  kind:   DirectiveKind;
  plan(dir: Pick<Directive, 'kind' | 'params' | 'toAgentId'> & { id?: string }, ctx: ExecContext): PlanResult;
  apply(change: Change, dir: Pick<Directive, 'id' | 'toAgentId' | 'kind'>): Promise<Applied>;
  verify(dir: Directive): Promise<VerifyResult>;
}

export const isPlanError = (x: PlanResult | null | undefined): x is PlanError => !!x && 'error' in x;
