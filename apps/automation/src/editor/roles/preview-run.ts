import type { ToolContext, EditorTool } from '../harness/tool';
import type { SlotResultPatch } from '../repo/editor-plans.repository';
import type { StoredCritic } from '../critic/critic';

/**
 * Spec 034 FR-012: the owner's on-demand Preview of a fixed planned slot — the
 * executor runs in dry mode: every publish guard and the critic run, but
 * nothing is published, stored as shadow, put up for approval or written to
 * the content ledger, and the slot keeps its status. The result is kept apart
 * from what the real run writes (`editor_slots.preview_draft`, migration 070).
 */
export type SlotPreviewStatus = 'running' | 'ready' | 'rejected' | 'skipped' | 'failed';

export interface SlotPreview {
  status:     SlotPreviewStatus;
  /** telegram | instagram | facebook | threads | tiktok. */
  platform:   string | null;
  /** Telegram: the rendered HTML; other platforms: the caption. */
  preview:    string | null;
  spec:       unknown;
  critic:     StoredCritic | null;
  /** Why there is no post (skip, critic reject, error), in the system's words. */
  reason:     string | null;
  warnings:   string[];
  runId:      string | null;
  /** The executor run and every critic pass. */
  costUsd:    number;
  startedAt:  string;
  finishedAt: string | null;
}

/** A preview older than this while still `running` is stale (a crashed process); a new one may start. */
export const PREVIEW_STALE_MS = 10 * 60_000;

/** The usage-ledger feature of a preview's executor run (spec 029); its critic passes stay `editor.checker`. */
export const PREVIEW_FEATURE = 'editor.preview';
/** Spec 059: the usage-ledger feature of a skill probe's executor runs (its critic passes stay `editor.checker`). */
export const PROBE_FEATURE = 'editor.probe';

export interface DryPost { platform: string; preview: string; spec: unknown; warnings: string[] }

/**
 * Collects what a dry executor run would have done. The publish tools call
 * `store` instead of storing / sending (see `dryRunOf`); the CriticGate gets
 * `plans` (its slot writes land here, never on the slot); skip_slot is wrapped
 * by `wrapTools`. Act tools (repurpose_post, edit_data_schema) are dropped.
 *
 * `probe` (spec 059): the run is a skill probe on a slot that was written long ago — the slot is `published` and its own
 * post, source and story are in the ledger, so the guards that compare a post with the ledger (similarity, source already
 * posted, poll cap, story registry, the schedule's publish guard) are skipped; lint, the critic and the content checks stay.
 * `maxCostUsd` stops the executor run once it has cost that much (the probe's own budget).
 */
export class PreviewSink {
  constructor(readonly probe = false, readonly maxCostUsd: number | null = null) {}

  post: DryPost | null = null;
  skipped: string | null = null;
  critic: StoredCritic | null = null;
  /** The critic stopped the post: `skipped` = reject / second revise, `failed` = the critic did not answer. */
  halted: { status: 'skipped' | 'failed'; error: string } | null = null;
  private readonly criticCost = new Map<number, number>();

  store(p: DryPost): void { this.post = p; }

  /** The CriticGate's slot writes: remembered, never written. */
  readonly plans = {
    updateSlot: async (_id: string, p: SlotResultPatch): Promise<void> => {
      if (p.critic) {
        this.critic = p.critic;
        this.criticCost.set(p.critic.pass, Number(p.critic.cost_usd) || 0);
      }
      if ((p.status === 'skipped' || p.status === 'failed') && p.error) this.halted = { status: p.status, error: p.error };
    },
  };

  /** USD of every critic pass of this run. */
  criticCostUsd(): number {
    return [...this.criticCost.values()].reduce((s, n) => s + n, 0);
  }

  /** Dry tools: no act tools; skip_slot records the reason instead of skipping the slot. */
  wrapTools(tools: EditorTool[]): EditorTool[] {
    return tools.filter((t) => t.kind !== 'act').map((t) => t.name !== 'skip_slot' ? t : {
      ...t,
      execute: async (input: any) => {
        this.skipped = input?.code ? `${input.code}: ${input.reason}` : `skipped by agent: ${input?.reason ?? ''}`;
        return { ok: true, skipped: true, dry: true };
      },
    });
  }

  /** The finished preview (status, reason, critic) from what the run did. */
  outcome(o: { platform: string; runId: string | null; runCostUsd: number; runError: string | null; startedAt: string; finishedAt: string }): SlotPreview {
    const base = {
      platform: o.platform, runId: o.runId, critic: this.critic, startedAt: o.startedAt, finishedAt: o.finishedAt,
      costUsd: Number((o.runCostUsd + this.criticCostUsd()).toFixed(6)),
    };
    if (this.post) {
      return { ...base, status: 'ready', preview: this.post.preview, spec: this.post.spec, reason: null, warnings: this.post.warnings };
    }
    if (this.halted) {
      return { ...base, status: this.halted.status === 'skipped' ? 'rejected' : 'failed', preview: null, spec: null, reason: this.halted.error, warnings: [] };
    }
    if (this.skipped) return { ...base, status: 'skipped', preview: null, spec: null, reason: this.skipped, warnings: [] };
    return { ...base, status: 'failed', preview: null, spec: null, reason: o.runError ?? 'the executor finished without a post', warnings: [] };
  }
}

/** The dry-run sink of a preview run, if this run is one (ctx.extras.dryRun). */
export function dryRunOf(ctx: ToolContext): PreviewSink | null {
  const s = ctx.extras?.dryRun;
  return s instanceof PreviewSink ? s : null;
}

/** A finished preview without an executor run (agent paused, series source exhausted, an error). */
export function previewWithoutRun(status: Exclude<SlotPreviewStatus, 'running' | 'ready'>, reason: string, startedAt: string, platform: string | null = null): SlotPreview {
  return {
    status, platform, preview: null, spec: null, critic: null, reason, warnings: [], runId: null, costUsd: 0,
    startedAt, finishedAt: new Date().toISOString(),
  };
}
