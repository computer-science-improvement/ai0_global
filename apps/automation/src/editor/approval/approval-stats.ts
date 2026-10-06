import type { Pool } from 'pg';

/**
 * Approval stats (spec 031 FR-010/FR-011): how the owner decided on the posts
 * of a resource over the last N days. One row per decided post; the numbers are
 * a pure function of the rows, so the switch dialog, the agent page, the
 * "ready for autonomy" signal and the 029 Agents card all read the same thing.
 */

export type ApprovalOutcome = 'clean' | 'edited' | 'rejected' | 'expired';

/** One decided post. `waitSeconds`: from the end of the run that wrote it to the approval. */
export interface ApprovalDecisionRow {
  channelKey:   string;
  resourceRef:  string;
  outcome:      ApprovalOutcome;
  rejectReason: string | null;
  waitSeconds:  number | null;
}

export interface ApprovalStats {
  /** Approved without edits + edited. */
  approved:              number;
  approvedClean:         number;
  edited:                number;
  rejected:              number;
  /** Never approved in time (not an owner decision; reported apart). */
  expired:               number;
  /** approved / (approved + rejected); null without decisions. */
  approvalRate:          number | null;
  /** edited / approved; null without approvals. */
  editRate:              number | null;
  /** approvedClean / approved; null without approvals (the autonomy threshold reads it). */
  cleanRate:             number | null;
  medianTimeToApproveSec: number | null;
  topRejectReasons:      Array<{ reason: string; count: number }>;
  rejectedWithoutReason: number;
}

export interface ResourceApprovalStats extends ApprovalStats {
  channelKey:  string;
  resourceRef: string;
}

export interface ApprovalStatsReport {
  days:       number;
  from:       Date;
  to:         Date;
  resource:   string | null;
  channel:    string | null;
  totals:     ApprovalStats & { waiting: number };
  byResource: ResourceApprovalStats[];
}

export const TOP_REASONS = 5;

const ratio = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

/** A reject reason as it is grouped: trimmed, lower-case, inner whitespace collapsed, trailing dots dropped. */
export function normalizeReason(r: string): string {
  return r.trim().replace(/\s+/g, ' ').replace(/[.!…]+$/u, '').toLowerCase();
}

/** The numbers of a set of decided posts. */
export function computeApprovalStats(rows: ApprovalDecisionRow[]): ApprovalStats {
  const n = (o: ApprovalOutcome) => rows.filter((r) => r.outcome === o).length;
  const approvedClean = n('clean');
  const edited = n('edited');
  const rejected = n('rejected');
  const expired = n('expired');
  const approved = approvedClean + edited;
  const reasons = new Map<string, { reason: string; count: number }>();
  let rejectedWithoutReason = 0;
  for (const r of rows) {
    if (r.outcome !== 'rejected') continue;
    const text = r.rejectReason?.trim();
    if (!text) { rejectedWithoutReason++; continue; }
    const key = normalizeReason(text);
    const e = reasons.get(key) ?? { reason: text, count: 0 };
    e.count++;
    reasons.set(key, e);
  }
  const waits = rows.filter((r) => (r.outcome === 'clean' || r.outcome === 'edited') && r.waitSeconds != null && r.waitSeconds >= 0)
    .map((r) => r.waitSeconds!);
  return {
    approved, approvedClean, edited, rejected, expired,
    approvalRate: ratio(approved, approved + rejected),
    editRate: ratio(edited, approved),
    cleanRate: ratio(approvedClean, approved),
    medianTimeToApproveSec: median(waits),
    topRejectReasons: [...reasons.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)).slice(0, TOP_REASONS),
    rejectedWithoutReason,
  };
}

/** Totals plus one block per resource (busiest first). */
export function buildReport(
  rows: ApprovalDecisionRow[], waiting: number, o: { days: number; from: Date; to: Date; resource?: string | null; channel?: string | null },
): ApprovalStatsReport {
  const groups = new Map<string, ApprovalDecisionRow[]>();
  for (const r of rows) groups.set(r.resourceRef, [...(groups.get(r.resourceRef) ?? []), r]);
  const byResource = [...groups.entries()].map(([ref, rs]) => ({ channelKey: rs[0].channelKey, resourceRef: ref, ...computeApprovalStats(rs) }))
    .sort((a, b) => (b.approved + b.rejected + b.expired) - (a.approved + a.rejected + a.expired) || a.resourceRef.localeCompare(b.resourceRef));
  return {
    days: o.days, from: o.from, to: o.to, resource: o.resource ?? null, channel: o.channel ?? null,
    totals: { ...computeApprovalStats(rows), waiting }, byResource,
  };
}

export interface StatsFilter {
  /** A channel key (@chan: every resource of that network) or a resource ref (telegram:@chan, instagram:123). */
  resource?: string | null;
  /** The anchor channel: every resource of its network. */
  channel?:  string | null;
  from:      Date;
  to:        Date;
}

/** Same resource matching as the approvals list (ApprovalsRepository.list). */
const MATCH = `($1::text IS NULL OR s.channel_key = $1 OR s.resource_ref = $1 OR ('telegram:' || s.channel_key = $1 AND s.resource_ref IS NULL))
           AND ($2::text IS NULL OR s.channel_key = $2)`;

/**
 * The decided posts of a window. A post counts on the day it was decided:
 * approval time for approved posts (edited or not), the last update for
 * rejected and expired ones. Posts dropped by a mode change or a replan are
 * not decisions and are left out.
 */
export class ApprovalStatsRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async decisions(f: StatsFilter): Promise<ApprovalDecisionRow[]> {
    const { rows } = await this.pool.query(
      `SELECT s.channel_key, COALESCE(s.resource_ref, 'telegram:' || s.channel_key) AS resource_ref,
              CASE WHEN s.approved_at IS NOT NULL THEN CASE WHEN s.owner_edited THEN 'edited' ELSE 'clean' END
                   WHEN s.status = 'skipped' AND s.error = 'rejected by owner' THEN 'rejected'
                   ELSE 'expired' END AS outcome,
              s.reject_reason,
              EXTRACT(EPOCH FROM (s.approved_at - r.finished_at))::float8 AS wait_s
         FROM editor_slots s
         LEFT JOIN editor_runs r ON r.id = s.run_id
        WHERE ${MATCH}
          AND (s.approved_at IS NOT NULL
               OR (s.status = 'skipped' AND s.error = 'rejected by owner')
               OR (s.status = 'expired' AND s.approved_at IS NULL))
          AND COALESCE(s.approved_at, s.updated_at) >= $3 AND COALESCE(s.approved_at, s.updated_at) < $4
        LIMIT 20000`,
      [f.resource?.trim() || null, f.channel?.trim() || null, f.from, f.to]);
    return rows.map((r) => ({
      channelKey: r.channel_key, resourceRef: r.resource_ref, outcome: r.outcome as ApprovalOutcome,
      rejectReason: r.reject_reason ?? null, waitSeconds: r.wait_s == null ? null : Number(r.wait_s),
    }));
  }

  /** Posts waiting for the owner right now. */
  async waiting(f: Pick<StatsFilter, 'resource' | 'channel'>): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM editor_slots s WHERE s.status = 'awaiting_approval' AND ${MATCH}`,
      [f.resource?.trim() || null, f.channel?.trim() || null]);
    return Number(rows[0]?.n ?? 0);
  }

  async report(f: Omit<StatsFilter, 'from' | 'to'> & { days: number; now: Date }): Promise<ApprovalStatsReport> {
    const from = new Date(f.now.getTime() - f.days * 86_400_000);
    const filter = { resource: f.resource ?? null, channel: f.channel ?? null, from, to: f.now };
    const [rows, waiting] = await Promise.all([this.decisions(filter), this.waiting(filter)]);
    return buildReport(rows, waiting, { days: f.days, from, to: f.now, resource: filter.resource, channel: filter.channel });
  }
}
