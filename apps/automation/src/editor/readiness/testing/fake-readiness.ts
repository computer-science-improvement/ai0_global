import { findingKey } from '../../sysadmin/audit-text';
import type { AuditSeverity, Finding, Fix } from '../../sysadmin/audit.types';
import type { FixPorts } from '../../sysadmin/fix-runner';
import type { ReadinessRow, ReadinessWrite } from '../readiness.repository';
import { ReadinessService, type ReadinessDeps } from '../readiness.service';
import { CH, makeFacts, NOW } from './facts-fixture';

/**
 * Spec 072 T6/T7 test doubles: an in-memory `channel_readiness` that keeps the SQL's rules (an update never writes
 * `applied_hash`, an absent `notifiedBlockers` / `notifiedAt` keeps the stored value), a finding builder, and a `ReadinessService`
 * harness with a clock, a controllable doctor and recording fix ports.
 */

export class FakeReadinessRepo {
  rows = new Map<string, ReadinessRow>();
  sweep = new Set<string>();
  upserts: ReadinessWrite[] = [];
  appliedHashWrites = 0;

  async get(k: string) { return this.rows.get(k) ?? null; }
  async upsert(w: ReadinessWrite): Promise<ReadinessRow> {
    this.upserts.push(w);
    const old = this.rows.get(w.channelKey);
    const row: ReadinessRow = {
      channelKey: w.channelKey, findings: w.findings, blockers: w.blockers, warnings: w.warnings, configHash: w.configHash,
      appliedHash: old?.appliedHash ?? null, checkedAt: w.checkedAt,
      notifiedAt: w.notifiedAt ?? old?.notifiedAt ?? null, notifiedBlockers: w.notifiedBlockers ?? old?.notifiedBlockers ?? [],
    };
    this.rows.set(w.channelKey, row);
    return row;
  }
  async setAppliedHash(k: string, h: string) {
    this.appliedHashWrites++;
    const r = this.rows.get(k);
    if (r) r.appliedHash = h;
    return !!r;
  }
  async sweepSet() { return [...this.sweep].sort(); }
  async inSweepSet(k: string) { return this.sweep.has(k); }
}

/** A doctor finding by hand: the key is stable per code and id. */
export function mkF(code: string, severity: AuditSeverity, over: Partial<Finding> & { id?: string; fix?: Fix } = {}): Finding {
  const { id, ...rest } = over;
  const subject = { type: 'channel' as const, id: id ?? code, label: code, channel: CH, agent: 'fx072' };
  return {
    key: findingKey('channel', code, subject), area: 'channel', check: code, severity, subject,
    title: `Title of ${code}`, detail: `Detail of ${code}`, evidence: {}, link: `/app/agents/fx072?tab=skills`, ...rest,
  };
}

export const MIN = 60_000;
export const HOUR = 3_600_000;

export interface Harness {
  svc: ReadinessService;
  repo: FakeReadinessRepo;
  clock: { now: Date; advance(ms: number): void };
  /** What the doctor says now; a test changes it between rechecks. */
  state: { findings: Finding[]; autoFix: boolean; slots: Array<{ status: string; error: string | null; verdict: string | null }> };
  calls: { load: number; doctor: number; hashtag: string[]; tools: Array<[string, string[]]>; skills: string[]; resumed: string[]; logs: string[] };
  /** Called by a test fix port when it should change what the doctor reports (e.g. drop the fixed finding). */
  onFix: { current?: (fix: string) => void };
  fixes: FixPorts;
}

/** A `ReadinessService` over fakes. Channels: `@fx072` is the card's spelling; `@FX072` and `@fx072` both resolve to it. */
export function harness(o: { deps?: Partial<ReadinessDeps>; sweep?: boolean; fixes?: Partial<FixPorts> } = {}): Harness {
  const repo = new FakeReadinessRepo();
  if (o.sweep !== false) repo.sweep.add(CH);
  const clock = { now: new Date(NOW), advance(ms: number) { this.now = new Date(this.now.getTime() + ms); } };
  const state: Harness['state'] = { findings: [], autoFix: true, slots: [] };
  const calls: Harness['calls'] = { load: 0, doctor: 0, hashtag: [], tools: [], skills: [], resumed: [], logs: [] };
  const onFix: Harness['onFix'] = {};
  const fixes: FixPorts = {
    agentByHandle: async () => null,
    patchSkill: async (_h, name) => { calls.skills.push(name); onFix.current?.(`skill:${name}`); },
    retireMemory: async () => true,
    applyConflicts: async () => ({ applied: [], remaining: [] }),
    addCardTools: async (c, t) => { calls.tools.push([c, t]); onFix.current?.(`tools:${t.join(',')}`); },
    setHashtagMin: async (c) => { calls.hashtag.push(c); onFix.current?.('hashtag'); },
    seriesPause: async () => ({ cause: 'no_material', resumed: false }),
    resumeSeriesPause: async (id) => { calls.resumed.push(id); onFix.current?.(`resume:${id}`); },
    ...o.fixes,
  };
  const svc = new ReadinessService({
    repo: repo as any,
    resolveKey: async (k) => (k.toLowerCase() === CH.toLowerCase() ? CH : null),
    load: async (_k, now) => { calls.load++; return makeFacts({ now }); },
    identity: async () => ({ mode: 'approve', agent: 'fx072' }),
    slots24h: async () => state.slots,
    fixes,
    autoFix: () => state.autoFix,
    doctor: () => { calls.doctor++; return state.findings.map((f) => ({ ...f })); },
    now: () => clock.now,
    log: (m) => calls.logs.push(m),
    ...o.deps,
  });
  return { svc, repo, clock, state, calls, onFix, fixes };
}
