// Spec 023 T7 phase B safety net. The strategy scheduler is gone: a `strategy_bindings` row that is still
// enabled and not retired no longer publishes anything. Production data cannot be checked when the code ships,
// so every boot (where the scheduler used to start) looks for such rows, logs a warning and writes ONE owner
// Inbox note per (Kyiv) day. Best-effort: nothing here can fail the boot.
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Pool } from 'pg';
import type { InboxItemInput } from '../editor/agents/owner-inbox';
import { kyivDay } from '../common/ai/usage/kyiv-day';

export const LEGACY_BINDINGS_KIND = 'legacy_bindings_enabled';
/** The dedup ref of the note: ref_type + ref_id = the Kyiv day (one note per boot-day). */
export const LEGACY_BINDINGS_REF_TYPE = 'legacy_bindings_day';

export interface EnabledLegacyBinding {
  extId:    string;
  type:     string;
  platform: string;
  /** channel_key, @meta_username or @tiktok_username; the binding's channel uuid when none resolves. */
  target:   string;
}

/** Enabled, not retired bindings — what the old scheduler would have run. Read-only. */
export const ENABLED_LEGACY_BINDINGS_SQL = `
  SELECT sb.ext_id, sb.type, sb.platform,
         COALESCE(t.channel_key, '@' || m.username, '@' || k.username, sb.channel_id::text) AS target
    FROM strategy_bindings sb
    LEFT JOIN tracked_channels t ON t.id = sb.channel_id
    LEFT JOIN meta_accounts   m ON m.id = sb.meta_account_id
    LEFT JOIN tiktok_accounts k ON k.id = sb.tiktok_account_id
   WHERE sb.enabled AND sb.retired_at IS NULL
   ORDER BY target, sb.type, sb.ext_id`;

/** "@chan (recipes, quotes); instagram @acct (recipe-carousel)" — grouped by target, platform named when not Telegram. */
export function describeBindings(rows: EnabledLegacyBinding[]): string {
  const groups = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = r.platform && r.platform !== 'telegram' ? `${r.platform} ${r.target}` : r.target;
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key)!.add(r.type);
  }
  return [...groups].map(([k, types]) => `${k} (${[...types].join(', ')})`).join('; ');
}

export function legacyBindingsNote(rows: EnabledLegacyBinding[], day: string): InboxItemInput & { refType: string; refId: string } {
  const list = describeBindings(rows);
  const text = `Legacy strategy bindings are enabled but no longer run: ${list}. `
    + 'Content for these channels is written by agents; migrate or disable them.';
  return {
    kind:     LEGACY_BINDINGS_KIND,
    severity: 'action',
    title:    `Legacy strategy bindings are enabled but no longer run (${rows.length})`,
    body:     `${text}\n\nMigrate a channel with @ai0 or the migration card on /app/agents, or pause the bindings.`,
    refType:  LEGACY_BINDINGS_REF_TYPE,
    refId:    day,
    alert:    { title: '⚠️ Legacy strategy bindings are enabled but no longer run', body: text },
  };
}

export interface LegacyBindingsCheckDeps {
  pool:   Pick<Pool, 'query'>;
  /** The owner Inbox (OwnerInbox.postOnce); null when it is not available — then only the log warning. */
  inbox:  { postOnce(i: InboxItemInput & { refType: string; refId: string }): Promise<number | null> } | null;
  log:    { warn(m: string): void; log(m: string): void };
  now?:   () => Date;
}

export interface LegacyBindingsCheckResult {
  bindings:   EnabledLegacyBinding[];
  /** The Inbox item id when a note was written now; null when none (nothing enabled, already noted today, no inbox, or a failure). */
  noted:      number | null;
  /** Runs a previous process left at 'running' that were closed now. */
  orphanedRuns: number;
}

/**
 * The boot check. Never throws: every failure is logged and the result is what could be done.
 * Also closes `strategy_runs` rows left at 'running' (the scheduler used to do this on boot).
 */
export async function checkLegacyBindings(d: LegacyBindingsCheckDeps): Promise<LegacyBindingsCheckResult> {
  const out: LegacyBindingsCheckResult = { bindings: [], noted: null, orphanedRuns: 0 };
  try {
    const { rowCount } = await d.pool.query(
      `UPDATE strategy_runs SET finished_at = now(), status = 'error', error = 'interrupted: service restarted mid-run',
              duration_ms = EXTRACT(EPOCH FROM (now() - started_at)) * 1000
        WHERE status = 'running'`);
    out.orphanedRuns = rowCount ?? 0;
    if (out.orphanedRuns > 0) d.log.warn(`Closed ${out.orphanedRuns} legacy strategy run(s) left at 'running'`);
  } catch (err: any) {
    d.log.warn(`legacy run reconcile failed: ${err?.message ?? err}`);
  }
  try {
    const { rows } = await d.pool.query(ENABLED_LEGACY_BINDINGS_SQL);
    out.bindings = rows.map((r: any) => ({ extId: r.ext_id, type: r.type, platform: r.platform ?? 'telegram', target: r.target ?? '?' }));
  } catch (err: any) {
    d.log.warn(`legacy bindings check failed: ${err?.message ?? err}`);
    return out;
  }
  if (!out.bindings.length) return out;
  d.log.warn(
    `${out.bindings.length} legacy strategy binding(s) are enabled but no longer run (spec 023 phase B): `
    + `${describeBindings(out.bindings)}. Migrate them to agents or disable them.`);
  if (!d.inbox) return out;
  try {
    out.noted = await d.inbox.postOnce(legacyBindingsNote(out.bindings, kyivDay(d.now?.() ?? new Date())));
  } catch (err: any) {
    d.log.warn(`legacy bindings Inbox note failed: ${err?.message ?? err}`);
  }
  return out;
}

/** Runs the check once per boot, in the background (the boot never waits for it or fails because of it). */
export class LegacyBindingsCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger('LegacyBindingsCheck');

  constructor(private readonly deps: Omit<LegacyBindingsCheckDeps, 'log'> | null) {}

  onApplicationBootstrap(): void {
    if (!this.deps) return;
    void checkLegacyBindings({ ...this.deps, log: this.logger }).catch((err) =>
      this.logger.warn(`legacy bindings check crashed: ${err?.message ?? err}`));
  }
}
