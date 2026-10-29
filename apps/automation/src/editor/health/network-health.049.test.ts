/** Spec 049 FR-005: the network health view and the weekly report section. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BudgetStatus } from '../../spend/spend.service';
import { budgetLines, healthReportSection, networkHealth, type ConnectionIssue, type SourceIssue } from './network-health';
import { NetworkHealthService } from './network-health.service';

const NOW = new Date('2026-10-18T12:00:00Z');

const cap = (o: Partial<BudgetStatus> & Pick<BudgetStatus, 'scopeKind' | 'scopeKey' | 'label'>): BudgetStatus => ({
  id: 1, dailyUsd: 3, monthlyUsd: null, alertPct: 80, enforce: true, seededFrom: null, updatedAt: null,
  spentTodayUsd: 1, spentMonthUsd: 1, pct: 33.3, state: 'ok', ...o,
});
const conn = (ref: string, state: ConnectionIssue['state']): ConnectionIssue => ({
  ref, title: null, state, detail: null, since: null, checkedAt: null, expiresAt: null, muted: false, agent: null,
});
const src = (id: string, state: SourceIssue['state'], slotsLost = 0): SourceIssue => ({
  id, kind: 'rss', ref: `https://${id}.test/feed`, state, calls: 4, ok: 0, empty: 0, errors: 4, successRate: 0, lastOkAt: null,
  lastError: null, blocked: null, slotsLost, detail: '0 of 4 reads worked in 14 d', channelKey: '@c', agent: 'c_editor',
});

test('budget lines: the total, agents and chat caps first, then other caps, then agents near their cap', () => {
  const lines = budgetLines([
    cap({ scopeKind: 'provider', scopeKey: 'openai', label: 'Provider openai', pct: 95, state: 'danger' }),
    cap({ scopeKind: 'feature_prefix', scopeKey: 'editor.chat', label: 'Owner chat' }),
    cap({ scopeKind: 'feature_prefix', scopeKey: 'editor.', label: 'Agents' }),
    cap({ scopeKind: 'global', scopeKey: '', label: 'Total' }),
    cap({ scopeKind: 'provider', scopeKey: 'x', label: 'No cap', dailyUsd: null }),
  ], [
    { agentId: 'a', handle: 'calm', capUsd: 1, spentUsd: 0.1, pct: 10, state: 'ok' },
    { agentId: 'b', handle: 'hot', capUsd: 1, spentUsd: 0.95, pct: 95, state: 'danger' },
  ]);
  assert.deepEqual(lines.map((l) => l.label), ['Total', 'Agents', 'Owner chat', 'Provider openai', 'Agent @hot']);
});

test('the view sorts each section worst first, drops empty stuck groups and counts the problems', () => {
  const h = networkHealth({
    now: NOW,
    connections: [conn('telegram:@b', 'token_expiring'), conn('instagram:1', 'token_invalid')],
    sources: [src('quiet', 'exhausted'), src('dead', 'failing', 2), src('wall', 'blocked')],
    budget: { rows: [cap({ scopeKind: 'global', scopeKey: '', label: 'Total', spentTodayUsd: 2.9, pct: 96.7, state: 'danger' })], agentCaps: [], blocking: [], slotsHit: 2 },
    stuck: [
      { kind: 'ideas_waiting', count: 3, oldestAt: NOW.toISOString(), items: [] },
      { kind: 'slot_failed', count: 1, oldestAt: NOW.toISOString(), items: [{ id: 's1', title: 'Topic', at: NOW.toISOString(), channelKey: '@c', detail: 'publish_failed' }] },
      { kind: 'slot_running', count: 0, oldestAt: null, items: [] },
    ],
  });
  assert.deepEqual(h.connections.map((c) => c.state), ['token_invalid', 'token_expiring']);
  assert.deepEqual(h.sources.map((s) => s.id), ['wall', 'dead', 'quiet']);
  assert.deepEqual(h.stuck.map((g) => [g.kind, g.label]), [['slot_failed', 'Failed posts'], ['ideas_waiting', 'Ideas nobody reviewed']]);
  assert.equal(h.problems, 2 + 3 + 1 + 4);

  const text = healthReportSection(h, 2);
  assert.match(text, /^Network health\n\nConnections \(2\)\n- instagram:1: token does not work\n- telegram:@b: token expires soon/);
  assert.match(text, /Sources \(3\)\n- @c «wall» \(rss\): blocked — 0 of 4 reads worked in 14 d\n- @c «dead» \(rss\): failing — .*\n- and 1 more/);
  assert.match(text, /Budget \(1\)\n- Total: \$2\.90 of \$3\.00 today \(97 %\)\n- 2 posts waited for or skipped by a cap today/);
  assert.match(text, /Stuck work \(2\)\n- Failed posts: 1 \(failed in the last 24 h\)\n- Ideas nobody reviewed: 3 \(new for over 48 h\)$/);
});

test('all clear is one line; a budget-hit slot without a tight cap still gets its heading', () => {
  const empty = { now: NOW, connections: [], sources: [], budget: { rows: [], agentCaps: [], blocking: [], slotsHit: 0 }, stuck: [] };
  assert.equal(healthReportSection(networkHealth(empty)), 'Network health\nAll clear: connections work, sources answer, budgets have room, nothing is stuck.');
  const hit = networkHealth({ ...empty, stuck: [{ kind: 'slot_overdue', count: 1, oldestAt: null, items: [] }], budget: { ...empty.budget, slotsHit: 1 } });
  assert.match(healthReportSection(hit), /\n\nBudget\n- 1 post waited for or skipped by a cap today/);
});

test('the service keeps going when a part fails: a broken source report or budget read leaves the rest', async () => {
  const pool: any = {
    query: async (sql: string) => {
      if (sql.includes('FROM agents WHERE parent_id IS NULL')) return { rows: [{ scope: 'resource', scope_id: 'telegram:@c', handle: 'c_editor' }] };
      if (sql.includes('FROM resource_profiles')) return { rows: [{ resource_ref: 'telegram:@c', resource_health: { state: 'no_access', detail: 'bot is not an admin', dismissedAt: '2026-10-17T00:00:00Z' } }] };
      if (sql.includes("s.status = 'failed'")) return { rows: [{ id: 's1', title: 'T', at: NOW, channel_key: '@c', detail: 'x', agent: null, total: '7' }] };
      if (sql.includes('count(*)::int AS n')) throw new Error('no table');
      return { rows: [] };
    },
  };
  const card: any = { channelKey: '@c', sources: [{ id: 'f', kind: 'rss', ref: 'https://f.test/feed' }] };
  const svc = new NetworkHealthService({
    pool, now: () => NOW,
    channels: { listActive: async () => [card, { ...card, channelKey: '@d' }] },
    sources: async (c) => { if (c.channelKey === '@d') throw new Error('boom'); return { channelKey: '@c', days: 14, sources: [src('f', 'failing')], otherHosts: [], noSources: false, proxyConfigured: false }; },
    budgets: async () => { throw new Error('spend down'); },
    catalog: { list: async () => [{ ref: 'telegram:@c', title: 'Channel C', agent: null }] },
  });
  const h = await svc.health();
  assert.deepEqual(h.connections.map((c) => [c.title, c.state, c.muted, c.agent]), [['Channel C', 'no_access', true, 'c_editor']]);
  assert.deepEqual(h.sources.map((s) => [s.channelKey, s.id, s.agent]), [['@c', 'f', 'c_editor']]);
  assert.deepEqual(h.stuck.map((g) => [g.kind, g.count, g.oldestAt]), [['slot_failed', 7, NOW.toISOString()]]);
  assert.deepEqual(h.budget, { lines: [], blocking: [], slotsHit: 0 });
});

// Spec 076 A22: a channel whose card lists no source can still have playbook sources (@ai0_prompts_dev: a dataset series, no card
// sources), so every active card is asked; a report that names no source at all (`noSources`) is skipped.
test('spec 076: a card with no sources of its own but a library series is in network health; a card with nothing at all is not', async () => {
  const pool = { query: async () => ({ rows: [] }) } as any;
  const series: SourceIssue = { ...src('series:Prompt of the day', 'exhausted'), kind: 'library', ref: 'prompts', origin: 'playbook', runway: { unposted: 0, days: null, rounds: false }, errors: 0, calls: 0 };
  const report = (channelKey: string, sources: SourceIssue[], noSources: boolean) => ({ channelKey, days: 14, sources, otherHosts: [], noSources, proxyConfigured: false });
  const svc = new NetworkHealthService({
    pool, now: () => NOW,
    channels: { listActive: async () => [{ channelKey: '@prompts', sources: [] } as any, { channelKey: '@blank', sources: [] } as any] },
    sources: async (c) => (c.channelKey === '@prompts' ? report('@prompts', [series], false) : report('@blank', [], true)),
    budgets: async () => ({ rows: [], agentCaps: [], blocking: [] }),
  });
  const h = await svc.health();
  assert.deepEqual(h.sources.map((s) => [s.channelKey, s.id, s.state, s.runway]), [['@prompts', 'series:Prompt of the day', 'exhausted', { unposted: 0, days: null, rounds: false }]]);
});

test('spec 076: a source the server cannot read is a problem even while its state is ok, and the weekly section says so', async () => {
  const probe = (ok: boolean) => ({ ok, failure_class: ok ? null : 'timeout' as const, status: ok ? 200 : null, kind: 'rss' as const, items: ok ? 5 : 0, newest_at: null, checked_at: NOW.toISOString(), via_proxy: false, detail: ok ? '5 items' : 'no answer in 10 s' });
  const geo: SourceIssue = { ...src('geo', 'ok'), errors: 0, calls: 0, probe: probe(false) };
  const fine: SourceIssue = { ...src('fine', 'ok'), errors: 0, calls: 3, probe: probe(true) };
  const never: SourceIssue = { ...src('never', 'unused'), errors: 0, calls: 0, probe: null };
  const svc = new NetworkHealthService({
    pool: { query: async () => ({ rows: [] }) } as any, now: () => NOW,
    channels: { listActive: async () => [{ channelKey: '@c', sources: [] } as any] },
    sources: async () => ({ channelKey: '@c', days: 14, sources: [geo, fine, never], otherHosts: [], noSources: false, proxyConfigured: true }),
    budgets: async () => ({ rows: [], agentCaps: [], blocking: [] }),
  });
  const h = await svc.health();
  assert.deepEqual(h.sources.map((s) => s.id), ['geo'], 'a good probe and a source never read are not problems');
  assert.equal(h.problems, 1);
  assert.match(healthReportSection(h), /- @c «geo» \(rss\): the server cannot read it — /);
});
