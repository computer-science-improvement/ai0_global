import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditController } from './audit.controller';
import { auditActions, auditSummary, auditTitle } from './audit-artifact';
import { reportCounts, type ReportFinding } from './audit-report';
import { parseSlash, runSlash, SLASH_COMMANDS } from '../chat/slash-commands';
import { ARTIFACT_TYPES } from '../artifacts/artifact.types';

const f = (key: string, severity: 'info' | 'warn' | 'error', status: ReportFinding['status'] = 'open', fix = false): ReportFinding => ({
  key, area: 'skills', check: 'c', severity, subject: { type: 'skill', id: key, label: key }, title: key, detail: 'd', evidence: {}, status,
  ...(fix ? { fix: { kind: 'skill_disable' as const, agent: 'a', skill: 's' } } : {}),
});

test('counts cover the open and failed findings only; fixable counts those with a fix', () => {
  const c = reportCounts([f('a', 'error', 'open', true), f('b', 'warn', 'failed', true), f('c', 'info', 'applied', true), f('d', 'info', 'dismissed'), f('e', 'info')]);
  assert.deepEqual(c, { total: 5, open: 3, error: 1, warn: 1, info: 1, fixable: 2 });
});

test('artifact row text: running, failed, nothing, counts, all handled; Run again only when nothing runs', () => {
  const base = { error: null, summary: null };
  const counts = (fs: ReportFinding[]) => reportCounts(fs);
  assert.equal(auditSummary({ ...base, status: 'running', counts: counts([]) }), 'running');
  assert.equal(auditSummary({ ...base, status: 'failed', error: 'boom', counts: counts([]) }), 'failed — boom');
  assert.equal(auditSummary({ ...base, status: 'done', counts: counts([]) }), 'nothing to report');
  assert.equal(auditSummary({ ...base, status: 'done', counts: counts([f('a', 'error', 'open', true), f('b', 'warn'), f('c', 'warn')]) }), '1 error · 2 warnings · 1 fixable');
  assert.equal(auditSummary({ ...base, status: 'done', counts: counts([f('a', 'error', 'applied')]) }), 'all handled');
  assert.deepEqual(auditActions('running'), []);
  assert.equal(auditActions('done')[0].path, '/api/audits/run');
  assert.equal(auditTitle({ week: '2026-W43', trigger: 'owner' }), 'Audit · 2026-W43 (on request)');
});

test('the audit is an artifact type, so chips, mentions and the artifact tools know it', () => {
  assert.ok((ARTIFACT_TYPES as readonly string[]).includes('audit'));
});

test('/audit runs in code: one line and the running report as a chip; refusals say why', async () => {
  assert.ok(SLASH_COMMANDS.some((c) => c.name === 'audit'));
  const cmd = parseSlash('/audit')!;
  const chip = { type: 'audit' as const, id: 'r1', title: 'Audit · 2026-W43 (on request)', status: 'running' };
  const deps = (audit?: any) => ({ setup: async () => ({ ok: false as const, error: 'x' }), steer: async () => ({ ok: false as const, error: 'x' }), launch: async () => ({ ok: false as const, error: 'x' }), list: async () => [], audit });
  const ok = await runSlash(cmd, { agent: null, channel: null }, deps(async () => ({ ok: true, chip })));
  assert.deepEqual(ok.artifacts, [chip]);
  assert.match(ok.content, /Audit started/);
  const busy = await runSlash(cmd, { agent: null, channel: null }, deps(async () => ({ ok: false, error: 'already_running', chip })));
  assert.match(busy.content, /already running/);
  assert.deepEqual(busy.artifacts, [chip]);
  const week = await runSlash(cmd, { agent: null, channel: null }, deps(async () => ({ ok: false, error: 'week_taken', details: "this week's audit already ran" })));
  assert.match(week.content, /already ran/);
  const none = await runSlash(cmd, { agent: null, channel: null }, deps());
  assert.match(none.content, /not available/);
  const arg = await runSlash(parseSlash('/audit now')!, { agent: null, channel: null }, deps(async () => ({ ok: true, chip })));
  assert.match(arg.content, /Usage: \/audit/);
});

test('the controller maps outcomes to statuses with an error code', async () => {
  const report: any = { id: 'r', week: 'w', trigger: 'owner', status: 'running', findings: [], summary: null, llm: null, costUsd: 0, error: null, startedAt: new Date(), finishedAt: null };
  const mk = (over: any) => new AuditController({ runInBackground: async () => ({ ok: true, report }), get: async () => null, apply: async () => ({ ok: true, report }), dismiss: async () => ({ ok: true, report }), ...over } as any);
  const status = async (fn: () => Promise<unknown>) => { try { await fn(); return 200; } catch (e: any) { return [e.getStatus(), e.getResponse().error]; } };

  assert.equal((await mk({}).run() as any).counts.total, 0);
  assert.deepEqual(await status(() => mk({ runInBackground: async () => ({ ok: false, error: 'already_running' }) }).run()), [409, 'already_running']);
  assert.deepEqual(await status(() => mk({}).get('nope')), [404, 'report_not_found']);
  assert.deepEqual(await status(() => mk({ apply: async () => ({ ok: false, error: 'fix_failed', details: 'gone' }) }).apply('r', 'k')), [422, 'fix_failed']);
  assert.deepEqual(await status(() => mk({ apply: async () => ({ ok: false, error: 'not_open', details: 'applied' }) }).apply('r', 'k')), [409, 'not_open']);
  assert.deepEqual(await status(() => mk({ dismiss: async () => ({ ok: false, error: 'finding_not_found' }) }).dismiss('r', 'k', { days: 7 })), [404, 'finding_not_found']);
  let days: unknown;
  await mk({ dismiss: async (_i: string, _k: string, d: unknown) => { days = d; return { ok: true, report }; } }).dismiss('r', 'k', { days: 7 });
  assert.equal(days, 7);
  await mk({ dismiss: async (_i: string, _k: string, d: unknown) => { days = d; return { ok: true, report }; } }).dismiss('r', 'k', undefined);
  assert.equal(days, undefined);
});
