import type { Pool } from 'pg';
import { BINDING_REF_SQL } from './binding-guard';
import type { MigrationProposal } from './proposal';
import { isFail, type StrategyMigrationService } from './strategy-migration.service';

/**
 * `migrate:strategies --dry-run` (spec 023 FR-011): the proposal of every channel with enabled bindings,
 * printed for the owner. Reads only (the CLI's connection is read-only besides).
 */

export interface RefusedChannel { channel_key: string; error: string; details?: unknown; bindings: string[] }
export interface DryRunResult { channels: Array<MigrationProposal | RefusedChannel>; orphans: string[]; mapped: number; total: number }

const refused = (x: MigrationProposal | RefusedChannel): x is RefusedChannel => 'error' in x;

/** Telegram anchors of every enabled binding: its own channel, or the Telegram channel of its account group. */
export async function anchorsOfEnabledBindings(pool: Pick<Pool, 'query'>): Promise<{ anchors: Map<string, string[]>; orphans: string[] }> {
  const { rows } = await pool.query(
    `SELECT x.ext_id, x.resource_ref,
            COALESCE(CASE WHEN x.resource_ref LIKE 'telegram:%' THEN substr(x.resource_ref, 10) END,
                     (SELECT tc2.channel_key FROM tracked_channels tc2
                       WHERE tc2.group_id = COALESCE((SELECT m.group_id FROM meta_accounts m WHERE m.id = x.meta_account_id),
                                                     (SELECT t.group_id FROM tiktok_accounts t WHERE t.id = x.tiktok_account_id))
                         AND tc2.channel_key IS NOT NULL ORDER BY tc2.channel_key LIMIT 1)) AS anchor
       FROM (SELECT b.ext_id, b.meta_account_id, b.tiktok_account_id, ${BINDING_REF_SQL} AS resource_ref
               FROM strategy_bindings b LEFT JOIN tracked_channels tc ON tc.id = b.channel_id WHERE b.enabled) x
      ORDER BY x.ext_id`);
  const anchors = new Map<string, string[]>();
  const orphans: string[] = [];
  for (const r of rows) {
    if (!r.anchor) { orphans.push(String(r.ext_id)); continue; }
    anchors.set(r.anchor, [...(anchors.get(r.anchor) ?? []), String(r.ext_id)]);
  }
  return { anchors, orphans };
}

export async function dryRun(svc: StrategyMigrationService, pool: Pick<Pool, 'query'>, o: { channel?: string | null } = {}): Promise<DryRunResult> {
  const { anchors, orphans } = await anchorsOfEnabledBindings(pool);
  const keys = o.channel ? [o.channel] : [...anchors.keys()].sort();
  const channels: Array<MigrationProposal | RefusedChannel> = [];
  for (const key of keys) {
    const p = await svc.propose(key);
    channels.push(isFail(p) ? { channel_key: key, error: p.error, details: p.details, bindings: anchors.get(key) ?? [] } : p);
  }
  // A binding counts once (a group's Meta binding shows under its Telegram anchor).
  const seen = new Set<string>();
  let mapped = 0;
  let total = 0;
  for (const c of channels) {
    if (refused(c)) {
      for (const b of c.bindings) if (!seen.has(b)) { seen.add(b); total++; }
      continue;
    }
    for (const b of c.bindings) {
      if (seen.has(b.ext_id)) continue;
      seen.add(b.ext_id);
      total++;
      if (b.outcome !== 'unmappable') mapped++;
    }
  }
  if (!o.channel) total += orphans.length;
  return { channels, orphans: o.channel ? [] : orphans, mapped, total };
}

/** The owner-readable report. */
export function formatDryRun(r: DryRunResult): string {
  const out: string[] = [];
  for (const c of r.channels) {
    out.push(`=== ${c.channel_key}`);
    if (refused(c)) {
      out.push(`  refused: ${c.error}${c.details ? ` — ${String(c.details)}` : ''}`);
      for (const b of c.bindings) out.push(`  - ${b}: not migrated (${c.error})`);
      out.push('');
      continue;
    }
    out.push(`  agent @${c.agent?.handle ?? '?'} · active playbook v${c.active_version ?? '—'} · ${c.mapped}/${c.total} mapped`);
    for (const b of c.bindings) {
      const head = `  - ${b.ext_id} [${b.type}] ${b.resource_ref ?? '?'} "${b.schedule}"`;
      if (b.outcome === 'series') out.push(`${head} → series "${b.series}" ${b.cadence} · ${b.format}${b.source ? ` · ${b.source}${b.source_mode === 'required' ? ' (required)' : ''}` : ' · no source'}`);
      else if (b.outcome === 'frequency') out.push(`${head} → frequency ~${b.per_day}/day · ${b.format}${b.source ? ` · ${b.source}` : ''} (${b.reason})`);
      else out.push(`${head} → UNMAPPABLE: ${b.reason}`);
      for (const w of b.outcome === 'unmappable' ? [] : b.warnings) out.push(`      ! ${w}`);
    }
    if (c.errors.length) out.push(`  draft errors: ${c.errors.join('; ')}`);
    out.push('');
  }
  for (const o of r.orphans) out.push(`- ${o}: UNMAPPABLE: the destination has no Telegram anchor (not in an account group with a channel)`);
  const pct = r.total ? Math.round(r.mapped / r.total * 100) : 100;
  out.push(`Summary: ${r.mapped} of ${r.total} enabled binding(s) mapped (${pct}%). Dry run: nothing was written.`);
  return out.join('\n');
}
