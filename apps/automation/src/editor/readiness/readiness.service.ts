import type { ChannelMode } from '../card';
import type { Finding, Fix } from '../sysadmin/audit.types';
import { describeFix, tryFix, type FixPorts, type FixResult } from '../sysadmin/fix-runner';
import { isAutoSafeFix } from './auto-fix';
import { channelDoctor } from './doctor';
import { canonical, ChannelNotFound, configHash } from './facts';
import type { ChannelFacts } from './facts.types';
import { mkFinding } from './finding';
import type { ReadinessRepository, ReadinessRow, ReadinessWrite } from './readiness.repository';
import {
  AUTO_FIXED_CODE, buildView, countFindings, isAutoFixed, selectFixes, type ClosedSlotRow, type FixSelection, type ReadinessView,
} from './view';

/**
 * Spec 072 FR-006: the one place that runs the channel doctor and stores what it found. The checks are pure and cost nothing; the
 * facts are loaded in a fixed number of queries; no model is ever called here.
 *
 * What a recheck does depends on why it runs (A10):
 *
 *   reason        auto-fix   notify stamp / clear   hooks
 *   owner         yes        yes                    yes
 *   sweep         yes        yes                    yes
 *   start         yes        yes                    yes
 *   config_skip   no         yes                    yes
 *   fix           no         yes                    yes
 *   view          no         no                     yes
 *
 * "Auto-fix" is `AUTO_SAFE_FIX_KINDS` only, with `READINESS_AUTO_FIX` on, for a channel in the sweep set. The stamp and the clear
 * are for a channel in the sweep set too. A `view` only looks: opening the dashboard never changes the channel or sends a card.
 */

export type RecheckReason = 'sweep' | 'view' | 'owner' | 'start' | 'config_skip' | 'fix';

/**
 * What every `afterRecheck` hook gets. `prevHash` is the config hash stored before this recheck (null = the first one), `hash`
 * the hash of the config now and `appliedHash` what spec 074 last repaired the plan for (null = never). The hook runs on every
 * recheck, not only when the hashes differ.
 */
export interface RecheckEvent {
  channelKey: string;
  reason:     RecheckReason;
  prevHash:   string | null;
  hash:       string;
  appliedHash: string | null;
  facts:      ChannelFacts;
  /** The stored list: the doctor's findings with `firstSeenAt`, then the `auto_fixed` rows. */
  findings:   Finding[];
}
export type RecheckHook = (e: RecheckEvent) => void | Promise<void>;

export interface FixOutcome {
  /** One line per fix that was applied. */
  applied: string[];
  failed:  Array<{ code: string; error: string }>;
  view:    ReadinessView;
}

export const AUTO_FIX_REASONS: ReadonlySet<RecheckReason> = new Set<RecheckReason>(['owner', 'sweep', 'start']);
export const STAMP_REASONS: ReadonlySet<RecheckReason> = new Set<RecheckReason>(['owner', 'sweep', 'start', 'config_skip', 'fix']);
/** A stored row younger than this answers a plain GET without running the doctor (A11). */
export const VIEW_WINDOW_MS = 60_000;
/** At most one owner-bot stamp per channel in this time (FR-006.5, A9). */
export const STAMP_GATE_MS = 24 * 3_600_000;
/** An `auto_fixed` row stays in the list this long (A20). */
export const AUTO_FIXED_KEEP_MS = 24 * 3_600_000;
/** I5: only a blocker that has been there this long counts for the owner-bot card; one recheck never sends a card. */
export const BLOCKER_STABLE_MS = 5 * 60_000;

export interface ReadinessDeps {
  repo: Pick<ReadinessRepository, 'get' | 'upsert' | 'sweepSet' | 'inSweepSet'>;
  /** The card's own spelling of a key; null = no card (A27). */
  resolveKey(key: string): Promise<string | null>;
  /** `loadChannelFacts`: reads, never writes. */
  load(channelKey: string, now: Date): Promise<ChannelFacts>;
  /** The card's mode and its orchestrator's handle, for a view built from the stored row; null = no card. */
  identity(channelKey: string): Promise<{ mode: ChannelMode; agent: string | null } | null>;
  /** The closed slots of the last 24 hours (the one query a stored view makes). */
  slots24h(channelKey: string, now: Date): Promise<ClosedSlotRow[]>;
  fixes: FixPorts;
  /** `READINESS_AUTO_FIX`: read on every recheck, so the setting is live. */
  autoFix(): boolean;
  /** The doctor; tests swap it. */
  doctor?: (facts: ChannelFacts) => Finding[];
  now?: () => Date;
  log?: (msg: string) => void;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** What a fix is aimed at: the part of its `subject.id` that tells two applications of one kind apart. */
function autoFixTarget(fix: Fix): string {
  if (fix.kind === 'tools_allow_add') return fix.tools.join(',');
  return ('channel' in fix ? fix.channel : undefined) ?? fix.kind;
}

export class ReadinessService {
  private readonly hooks: RecheckHook[] = [];
  /** The tail of the work queued for a channel: a second recheck of the same channel waits for the first. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly d: ReadinessDeps) {}

  private now(): Date { return this.d.now?.() ?? new Date(); }
  private log(msg: string): void { this.d.log?.(msg); }
  private doctor(facts: ChannelFacts): Finding[] { return (this.d.doctor ?? channelDoctor)(facts); }

  /** `tryFix`, except that a kind the runner has no case for (075's, until it joins) is a refusal and not a crash. */
  private async applyFix(fix: Fix): Promise<FixResult> {
    return (await tryFix(this.d.fixes, fix)) ?? { ok: false, error: `fix_unavailable: ${fix.kind} is not wired in this process` };
  }

  /** Registers a hook that runs after every recheck (spec 074 registers its plan repair here). Returns the way to take it off. */
  afterRecheck(fn: RecheckHook): () => void {
    this.hooks.push(fn);
    return () => { const i = this.hooks.indexOf(fn); if (i >= 0) this.hooks.splice(i, 1); };
  }

  /** The card's spelling of the key (A27); no card = `ChannelNotFound`. */
  private async keyOf(key: string): Promise<string> {
    const k = await this.d.resolveKey((key ?? '').trim());
    if (!k) throw new ChannelNotFound(key);
    return k;
  }

  /** One job at a time per channel. A failed job does not stop the next one. */
  private locked<T>(key: string, job: () => Promise<T>): Promise<T> {
    const lk = key.toLowerCase();
    const prev = this.chains.get(lk) ?? Promise.resolve();
    const run = prev.then(job);
    const tail = run.then(() => undefined, () => undefined);
    this.chains.set(lk, tail);
    void tail.then(() => { if (this.chains.get(lk) === tail) this.chains.delete(lk); });
    return run;
  }

  /** Hooks run outside the lock, so a hook may start another recheck of the same channel. A throwing hook is logged and skipped. */
  private async emit(events: readonly RecheckEvent[]): Promise<void> {
    for (const e of events) {
      for (const h of [...this.hooks]) {
        try { await h(e); } catch (err: any) { this.log(`readiness: a hook failed after ${e.reason} of ${e.channelKey}: ${err?.message ?? err}`); }
      }
    }
  }

  // ── reads ────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The view of the stored row: the card, its agent and one slots query, never the facts. Null = the channel has no row yet. */
  async view(keyIn: string): Promise<ReadinessView | null> {
    const key = await this.keyOf(keyIn);
    const row = await this.d.repo.get(key);
    return row ? this.viewOf(row, this.now()) : null;
  }

  private async viewOf(row: ReadinessRow, now: Date): Promise<ReadinessView> {
    const [who, slots] = await Promise.all([this.d.identity(row.channelKey), this.d.slots24h(row.channelKey, now)]);
    if (!who) throw new ChannelNotFound(row.channelKey);
    return buildView(row, who, slots);
  }

  /** `GET …/readiness`: the stored row while it is under a minute old (or always, unless `fresh`), else one `view` recheck (A11). */
  async current(keyIn: string, o: { fresh?: boolean } = {}): Promise<ReadinessView> {
    const key = await this.keyOf(keyIn);
    const now = this.now();
    if (!o.fresh) {
      const row = await this.d.repo.get(key);
      if (row && now.getTime() - row.checkedAt.getTime() < VIEW_WINDOW_MS) return this.viewOf(row, now);
    }
    return this.recheckKey(key, 'view');
  }

  // ── recheck ──────────────────────────────────────────────────────────────────────────────────────────────────────

  async recheck(keyIn: string, reason: RecheckReason): Promise<ReadinessView> {
    return this.recheckKey(await this.keyOf(keyIn), reason);
  }

  private async recheckKey(key: string, reason: RecheckReason): Promise<ReadinessView> {
    const { view, event } = await this.locked(key, () => this.run(key, reason));
    await this.emit([event]);
    return view;
  }

  /** The recheck itself. Runs under the channel's lock (or inside `fix`, which holds it). */
  private async run(key: string, reason: RecheckReason): Promise<{ view: ReadinessView; event: RecheckEvent }> {
    const now = this.now();
    const prev = await this.d.repo.get(key);
    let facts = await this.d.load(key, now);
    let found = this.doctor(facts);

    // A `view` does not look at the sweep set: it neither fixes nor stamps.
    const inSet = reason === 'view' ? false : await this.d.repo.inSweepSet(key);

    // Auto-safe fixes: each one once, then one reload and one more run of the doctor (not a loop).
    let autoRows: Finding[] = [];
    if (AUTO_FIX_REASONS.has(reason) && inSet && this.d.autoFix()) {
      autoRows = await this.applyAutoFixes(facts, found, now, reason);
      if (autoRows.length) {
        facts = await this.d.load(key, now);
        found = this.doctor(facts);
      }
    }

    // firstSeenAt of a finding that was already open; a finding that closed and came back starts again.
    const nowIso = now.toISOString();
    const seen = new Map((prev?.findings ?? []).filter((f) => !isAutoFixed(f)).map((f) => [f.key, f.firstSeenAt]));
    const open = found.map((f): Finding => ({ ...f, firstSeenAt: seen.get(f.key) ?? nowIso }));

    // `auto_fixed` rows: this recheck's, then those of the last 24 hours (A20).
    const carried = (prev?.findings ?? []).filter((f) => isAutoFixed(f) && !!f.firstSeenAt && now.getTime() - Date.parse(f.firstSeenAt) < AUTO_FIXED_KEEP_MS);
    const have = new Set(autoRows.map((f) => f.key));
    const autoAll = [...autoRows, ...carried.filter((f) => !have.has(f.key))];

    const findings = [...open, ...autoAll];
    const counts = countFindings(findings);
    const hash = configHash(facts);

    const write: ReadinessWrite = {
      channelKey: key, findings, blockers: counts.blockers, warnings: counts.warnings, configHash: hash, checkedAt: now,
      ...(STAMP_REASONS.has(reason) && inSet ? this.notifyChange(prev, open, now) : {}),
    };
    const row = await this.d.repo.upsert(write);
    const view = buildView(row, { mode: facts.card.mode, agent: facts.agent?.handle ?? null }, facts.slots24h);
    return { view, event: { channelKey: key, reason, prevHash: prev?.configHash ?? null, hash, appliedHash: row.appliedHash, facts, findings } };
  }

  /**
   * A9, I5: what to write into `notified_blockers` / `notified_at`. Only the blockers that have been open for 5 minutes count
   * (one recheck never sends a card). No such blocker: the stored set is cleared at once, outside the 24 hour gate, and
   * `notified_at` stays. A different non-empty set is stamped only when nothing was stamped in the last 24 hours.
   */
  private notifyChange(prev: ReadinessRow | null, open: readonly Finding[], now: Date): Pick<ReadinessWrite, 'notifiedBlockers' | 'notifiedAt'> {
    const stable = open
      .filter((f) => f.severity === 'error' && now.getTime() - Date.parse(f.firstSeenAt ?? now.toISOString()) >= BLOCKER_STABLE_MS)
      .map((f) => f.key).sort();
    const was = [...(prev?.notifiedBlockers ?? [])].sort();
    if (!stable.length) return was.length ? { notifiedBlockers: [] } : {};
    if (sameSet(stable, was)) return {};
    if (prev?.notifiedAt && now.getTime() - prev.notifiedAt.getTime() < STAMP_GATE_MS) return {};
    return { notifiedBlockers: stable, notifiedAt: now };
  }

  /** Applies each distinct auto-safe fix of the open findings once. A fix that fails stays an open finding and is logged. */
  private async applyAutoFixes(facts: ChannelFacts, found: readonly Finding[], now: Date, reason: RecheckReason): Promise<Finding[]> {
    const done = new Set<string>();
    const rows: Finding[] = [];
    for (const f of found) {
      const fix = f.fix;
      if (!fix || !isAutoSafeFix(fix.kind)) continue;
      const id = canonical(fix);
      if (done.has(id)) continue;
      done.add(id);
      const r = await this.applyFix(fix);
      if (!r.ok) { this.log(`readiness: auto-fix of ${facts.channelKey} refused (${fix.kind}): ${r.error}`); continue; }
      this.log(`readiness: ${describeFix(fix)} (by itself, ${reason})`);
      rows.push({
        ...mkFinding(facts, {
          code: AUTO_FIXED_CODE, severity: 'info',
          subject: { type: 'channel', id: `${fix.kind}:${autoFixTarget(fix)}:${Math.floor(now.getTime() / 60_000)}`, label: describeFix(fix) },
          detail: r.applied ?? describeFix(fix), evidence: { fix },
        }),
        firstSeenAt: now.toISOString(),
      });
    }
    return rows;
  }

  // ── sweep ────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** A recheck for every channel of the sweep set, one at a time. A channel that fails is logged and the sweep goes on. */
  async sweep(): Promise<{ checked: number; failed: number }> {
    const keys = await this.d.repo.sweepSet();
    let checked = 0, failed = 0;
    for (const key of keys) {
      try { await this.recheckKey(key, 'sweep'); checked++; } catch (err: any) {
        failed++;
        this.log(`readiness: sweep of ${key} failed: ${err?.message ?? err}`);
      }
    }
    return { checked, failed };
  }

  // ── fix ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Applies the one-tap fixes of the open findings in the stored row (A13: see `selectFixes`), each through `tryFix`, and then
   * runs a `fix` recheck. Findings that carry the same fix are applied once. A channel with no row yet is looked at first.
   */
  async fix(keyIn: string, sel: FixSelection = {}, via: 'dashboard' | 'telegram' = 'dashboard'): Promise<FixOutcome> {
    const key = await this.keyOf(keyIn);
    const events: RecheckEvent[] = [];
    const out = await this.locked(key, async () => {
      let row = await this.d.repo.get(key);
      if (!row) {
        const first = await this.run(key, 'view');
        events.push(first.event);
        row = await this.d.repo.get(key);
      }
      const { picked, missing } = selectFixes(row?.findings ?? [], sel);
      const applied: string[] = [];
      const failed: FixOutcome['failed'] = [];
      const done = new Set<string>();
      for (const f of picked) {
        const id = canonical(f.fix);
        if (done.has(id)) continue;
        done.add(id);
        const r = await this.applyFix(f.fix!);
        if (r.ok) applied.push(r.applied ?? describeFix(f.fix!));
        else failed.push({ code: f.check, error: r.error ?? 'failed' });
      }
      for (const k of missing) failed.push({ code: 'finding_gone', error: `${k}: the finding is no longer open or has no fix` });
      this.log(`readiness: ${via} fix of ${key}: ${applied.length} applied, ${failed.length} failed`);
      const re = await this.run(key, 'fix');
      events.push(re.event);
      return { applied, failed, view: re.view };
    });
    await this.emit(events);
    return out;
  }
}
