import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutonomyUndo } from '../autonomy/autonomy-decisions.repository';
import { SILENCE_APPLY_AUDIT_FIX_KINDS, SILENCE_WAIT_AUDIT_FIX_KINDS } from '../autonomy/owner-gates';
import { AuditService, auditUndoFor } from './audit.service';
import { AuditTick } from './audit-schedule';
import { FIX_KINDS, type Fix } from './audit.types';
import type { AuditReport, ReportFinding } from './audit-report';

/** Spec 090 FR-006: safe audit findings are applied by code once the latest report is older than AUDIT_AUTO_FIX_HOURS. */

const REPORT_AT = new Date('2026-11-03T06:40:00.000Z');
const HOUR = 3_600_000;

const finding = (key: string, fix: Fix, check = 'c'): ReportFinding => ({
  key, area: 'memory', check, severity: 'warn', subject: { type: 'channel', id: key, label: key }, title: `Title ${key}`, detail: 'd', evidence: {}, status: 'open', fix,
});

function setup(findings: ReportFinding[], o: { hours?: string; silence?: string; failing?: string[]; now?: Date } = {}) {
  const report = { id: 'r1', week: '2026-W45', trigger: 'schedule', status: 'done', findings, summary: null, llm: null, costUsd: 0, error: null, startedAt: REPORT_AT, finishedAt: REPORT_AT } as AuditReport;
  const calls: string[] = [];
  const repo: any = {
    latest: async () => report,
    get: async () => report,
    updateFinding: async (_id: string, key: string, fn: (f: ReportFinding) => ReportFinding) => {
      report.findings = report.findings.map((f) => (f.key === key ? fn(f) : f));
      return report;
    },
  };
  const svc = new AuditService({
    repo, pass: async () => { throw new Error('unused'); },
    fixes: {
      agentByHandle: async () => null,
      patchSkill: async (h: string, s: string, p: any) => { calls.push(`skill:${h}:${s}:${JSON.stringify(p)}`); },
      retireMemory: async (c: string, id: number) => { if (o.failing?.includes('memory')) return false; calls.push(`retire:${c}:${id}`); return true; },
      reactivateMemory: async (c: string, id: number) => { calls.push(`reactivate:${c}:${id}`); return true; },
      applyConflicts: async () => ({ applied: [], remaining: [] }),
    } as any,
    now: () => o.now ?? new Date(REPORT_AT.getTime() + 25 * HOUR),
  });
  const rows: any[] = [];
  const decisions = { record: async (d: any) => { rows.push(d); return rows.length; } };
  const env = (k: string) => ({ AUDIT_AUTO_FIX_HOURS: o.hours, OWNER_SILENCE: o.silence } as Record<string, string | undefined>)[k];
  return { svc, report, calls, rows, decisions, env };
}

test('a memory_retire finding is applied after 24 h with by = auto:silence, a decision row and an undo; source_drop is not', async () => {
  const s = setup([
    finding('m', { kind: 'memory_retire', channel: '@c', id: 7 }),
    finding('d', { kind: 'source_drop', channel: '@c', sourceId: 'x' }),
    finding('h', { kind: 'host_proxy_add', host: 'a.example' }),
  ]);
  const r = await s.svc.silenceSweep({ env: s.env, decisions: s.decisions });
  assert.deepEqual(r, { applied: 1, failed: 0 });
  assert.deepEqual(s.calls, ['retire:@c:7']);
  assert.equal(s.report.findings[0].status, 'applied');
  assert.equal(s.report.findings[0].by, 'auto:silence');
  assert.equal(s.report.findings[1].status, 'open');
  assert.equal(s.report.findings[2].status, 'open');
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0].gate, 'audit_fix:memory_retire');
  assert.equal(s.rows[0].action, 'applied');
  assert.equal(s.rows[0].channelKey, '@c');
  assert.deepEqual(s.rows[0].undo, { kind: 'memory_retire', channel: '@c', id: 7 });
});

test('a report younger than AUDIT_AUTO_FIX_HOURS waits; 0 = off; OWNER_SILENCE=wait waits', async () => {
  const young = setup([finding('m', { kind: 'memory_retire', channel: '@c', id: 7 })], { now: new Date(REPORT_AT.getTime() + 23 * HOUR) });
  assert.deepEqual(await young.svc.silenceSweep({ env: young.env, decisions: young.decisions }), { applied: 0, failed: 0 });
  const off = setup([finding('m', { kind: 'memory_retire', channel: '@c', id: 7 })], { hours: '0' });
  assert.deepEqual(await off.svc.silenceSweep({ env: off.env, decisions: off.decisions }), { applied: 0, failed: 0 });
  const wait = setup([finding('m', { kind: 'memory_retire', channel: '@c', id: 7 })], { silence: 'wait' });
  assert.deepEqual(await wait.svc.silenceSweep({ env: wait.env, decisions: wait.decisions }), { applied: 0, failed: 0 });
  assert.equal(wait.rows.length + off.rows.length + young.rows.length, 0);
  const shorter = setup([finding('m', { kind: 'memory_retire', channel: '@c', id: 7 })], { hours: '12', now: new Date(REPORT_AT.getTime() + 13 * HOUR) });
  assert.equal((await shorter.svc.silenceSweep({ env: shorter.env, decisions: shorter.decisions })).applied, 1, 'the setting is read live');
});

test('series_resume is applied only for pause_cause_gone', async () => {
  const fix: Fix = { kind: 'series_resume', channel: '@c', pauseId: 'p1' };
  const s = setup([finding('a', fix, 'series_paused'), finding('b', { ...fix, pauseId: 'p2' }, 'pause_cause_gone')]);
  // The audit's ports do not wire the pause ports, so the allowed one fails with fix_unavailable; the other is never tried.
  const r = await s.svc.silenceSweep({ env: s.env, decisions: s.decisions });
  assert.deepEqual(r, { applied: 0, failed: 1 });
  assert.equal(s.report.findings[0].status, 'open', 'series_paused is not applied by code');
  assert.equal(s.report.findings[1].status, 'failed');
});

test('a failed fix stays failed, is logged once as failed, and is not tried again', async () => {
  const s = setup([finding('m', { kind: 'memory_retire', channel: '@c', id: 7 })], { failing: ['memory'] });
  assert.deepEqual(await s.svc.silenceSweep({ env: s.env, decisions: s.decisions }), { applied: 0, failed: 1 });
  assert.equal(s.report.findings[0].status, 'failed');
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0].action, 'failed');
  assert.equal(s.rows[0].undo, null);
  assert.deepEqual(await s.svc.silenceSweep({ env: s.env, decisions: s.decisions }), { applied: 0, failed: 0 });
  assert.equal(s.rows.length, 1);
});

test('an unknown fix kind waits instead of throwing', async () => {
  const s = setup([finding('x', { kind: 'brand_new_fix' } as unknown as Fix)]);
  assert.deepEqual(await s.svc.silenceSweep({ env: s.env, decisions: s.decisions }), { applied: 0, failed: 0 });
  assert.equal(s.report.findings[0].status, 'open');
});

test('every fix kind in the code is in the registry (apply or wait), so none falls to the unknown-kind path', () => {
  const known = new Set<string>([...SILENCE_APPLY_AUDIT_FIX_KINDS, ...SILENCE_WAIT_AUDIT_FIX_KINDS]);
  for (const k of FIX_KINDS) assert.ok(known.has(k), `${k} is missing from the owner-gate registry`);
  for (const k of known) assert.ok((FIX_KINDS as readonly string[]).includes(k), `${k} is in the registry but not a fix kind`);
});

test('undo exists only where fix-runner has an inverse', () => {
  const kinds = FIX_KINDS.filter((k) => auditUndoFor({ kind: k, channel: '@c', id: 1, agent: 'a', skill: 's', tools: [], pauseId: 'p', series: 's', sourceId: 'x', host: 'h' } as unknown as Fix) !== null);
  assert.deepEqual([...kinds].sort(), ['memory_retire', 'skill_inline_off']);
});

test('the undo handlers re-activate the memory row and put the skill back inline', async () => {
  const s = setup([]);
  const undo = new AutonomyUndo({} as any);
  s.svc.registerUndo(undo);
  const h = (undo as any).handlers;
  await h.get('memory_retire')({ kind: 'memory_retire', channel: '@c', id: 7 }, {});
  await h.get('skill_inline_off')({ kind: 'skill_inline_off', agent: 'a', skill: 'sk' }, {});
  assert.deepEqual(s.calls, ['reactivate:@c:7', 'skill:a:sk:{"inline":true}']);
});

test('the audit tick runs the silence step at most once an hour, also when no audit is due', async () => {
  let n = 0;
  let t = new Date('2026-11-04T12:00:00Z');
  const tick = new AuditTick({ svc: { run: async () => { throw new Error('unused'); } } as any, inbox: {} as any, env: () => undefined, now: () => t, silence: async () => { n++; } });
  await tick.tick();
  t = new Date(t.getTime() + 30 * 60_000);
  await tick.tick();
  assert.equal(n, 1);
  t = new Date(t.getTime() + 31 * 60_000);
  await tick.tick();
  assert.equal(n, 2);
});
