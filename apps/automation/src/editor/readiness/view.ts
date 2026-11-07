import type { ChannelMode } from '../card';
import { isNotAMiss, skipGroupOf } from '../silent/skip-reasons';
import type { Finding, FindingSubject } from '../sysadmin/audit.types';
import { fixLabel } from '../sysadmin/fix-runner';
import { isAutoSafeFix, isDestructiveFix, isFixAllKind } from './auto-fix';

/**
 * Spec 072 FR-007, A11, A13, A20: what the API and the dashboard see of the stored row. Pure: the service reads, this shapes.
 * The `Fix` itself stays on the server; the view carries its label and whether code may apply it by itself.
 */

/** The code of the info rows the service writes when it applies a fix by itself (A20). */
export const AUTO_FIXED_CODE = 'auto_fixed';
export const isAutoFixed = (f: Pick<Finding, 'check'>): boolean => f.check === AUTO_FIXED_CODE;

export interface ReadinessFinding {
  key: string; code: string; severity: 'error' | 'warn' | 'info'; title: string; detail: string;
  subject: FindingSubject; link: string | null; firstSeenAt: string | null;
  /**
   * The Fix itself stays on the server. `inFixAll`: whether Fix all and «Виправити все» apply it (`isFixAllKind`, lead at the
   * 076 merge), so the Fix all confirm lists only what it will do. `destructive`: the row's Fix removes something (W1
   * integration review), so its confirm names the subject in the danger style; absent otherwise.
   */
  fix: { label: string; auto: boolean; inFixAll: boolean; destructive?: true } | null;
}

export interface Last24h { planned: number; published: number; awaiting: number; skipped: number; byGroup: Record<string, number> }

export interface ReadinessView {
  channelKey: string; agent: string | null; mode: ChannelMode; checkedAt: string; configHash: string;
  blockers: number; warnings: number; infos: number; fixable: number;
  findings: ReadinessFinding[];
  last24h: Last24h;
  topFix: { key: string; title: string; link: string | null } | null;
}

export const toReadinessFinding = (f: Finding): ReadinessFinding => ({
  key: f.key, code: f.check, severity: f.severity, title: f.title, detail: f.detail, subject: f.subject,
  link: f.link ?? null, firstSeenAt: f.firstSeenAt ?? null,
  fix: f.fix ? {
    label: fixLabel(f.fix), auto: isAutoSafeFix(f.fix.kind, f.check), inFixAll: isFixAllKind(f.fix.kind),
    ...(isDestructiveFix(f.fix.kind) ? { destructive: true as const } : {}),
  } : null,
});

/** Open errors, warnings and infos; the `auto_fixed` rows are in none of them (A20). */
export function countFindings(findings: readonly Finding[]): { blockers: number; warnings: number; infos: number } {
  let blockers = 0, warnings = 0, infos = 0;
  for (const f of findings) {
    if (isAutoFixed(f)) continue;
    if (f.severity === 'error') blockers++;
    else if (f.severity === 'warn') warnings++;
    else infos++;
  }
  return { blockers, warnings, infos };
}

/** Fix all, `fixable` and «Виправити все» cover open errors and warnings whose fix kind is not excluded (A13). Info rows keep their own button. */
export const isFixAllTarget = (f: Finding): boolean =>
  !isAutoFixed(f) && (f.severity === 'error' || f.severity === 'warn') && !!f.fix && isFixAllKind(f.fix.kind);

/** The first blocker with a fix, else the first blocker (the findings come errors first). */
export function topFixOf(findings: readonly Finding[]): ReadinessView['topFix'] {
  const blockers = findings.filter((f) => f.severity === 'error' && !isAutoFixed(f));
  const top = blockers.find((f) => !!f.fix) ?? blockers[0];
  return top ? { key: top.key, title: top.title, link: top.link ?? null } : null;
}

/** A closed slot as `ChannelFacts.slots24h` and the view's own query hold it. */
export interface ClosedSlotRow { status: string; error: string | null; verdict: string | null }

const SKIPPED = new Set(['skipped', 'failed', 'expired']);
const AWAITING = new Set(['awaiting_approval', 'approved']);
const COUNTED = new Set(['published', 'shadowed', ...SKIPPED, ...AWAITING]);

/**
 * The last 24 hours (A15): planned = every closed slot except the skips the owner or the system chose (`isNotAMiss`), which are
 * neither planned nor skipped; `byGroup` counts the skipped by `skipGroupOf`, so a group that is added later appears by itself.
 */
export function last24hOf(rows: readonly ClosedSlotRow[]): Last24h {
  const out: Last24h = { planned: 0, published: 0, awaiting: 0, skipped: 0, byGroup: {} };
  for (const r of rows) {
    if (!COUNTED.has(r.status)) continue;
    if (SKIPPED.has(r.status)) {
      if (isNotAMiss(r.error)) continue;
      out.skipped++;
      const g = skipGroupOf(r.error, r.verdict);
      out.byGroup[g] = (out.byGroup[g] ?? 0) + 1;
    } else if (r.status === 'published') out.published++;
    else if (AWAITING.has(r.status)) out.awaiting++;
    out.planned++;
  }
  return out;
}

export interface StoredReadiness { channelKey: string; findings: Finding[]; configHash: string; checkedAt: Date }

export function buildView(row: StoredReadiness, who: { mode: ChannelMode; agent: string | null }, slots: readonly ClosedSlotRow[]): ReadinessView {
  const c = countFindings(row.findings);
  return {
    channelKey: row.channelKey, agent: who.agent, mode: who.mode, checkedAt: new Date(row.checkedAt).toISOString(), configHash: row.configHash,
    ...c, fixable: row.findings.filter(isFixAllTarget).length,
    findings: row.findings.map(toReadinessFinding),
    last24h: last24hOf(slots),
    topFix: topFixOf(row.findings),
  };
}

// ── which findings a fix request applies to ───────────────────────────────────────────────────────────────────────

/** The body of `POST …/readiness/fix` (A13). */
export interface FixSelection { codes?: string[]; keys?: string[] }

/**
 * A13: no field = Fix all (open errors and warnings with a fix of a kind that is not excluded); `codes` = the open findings with
 * those codes, any severity; `keys` = those findings only (each row's button sends its own key). Both given = the findings that
 * match both. An empty list selects nothing. The exclusion list applies to Fix all only: a row's own button may apply it.
 * `missing` = keys that name no open finding with a fix (fixed or gone since the owner looked).
 */
export function selectFixes(findings: readonly Finding[], sel: FixSelection): { picked: Finding[]; missing: string[] } {
  const open = findings.filter((f) => !isAutoFixed(f) && !!f.fix);
  if (!sel.codes && !sel.keys) return { picked: open.filter(isFixAllTarget), missing: [] };
  const codes = sel.codes ? new Set(sel.codes) : null;
  const keys = sel.keys ? new Set(sel.keys) : null;
  const picked = open.filter((f) => (!codes || codes.has(f.check)) && (!keys || keys.has(f.key)));
  const have = new Set(open.map((f) => f.key));
  return { picked, missing: sel.keys ? sel.keys.filter((k) => !have.has(k)) : [] };
}
