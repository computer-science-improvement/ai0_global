import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent } from '../agents/agent.types';
import type { LoadoutSuggestion } from './loadout-suggestions';
import {
  agentLine, digestLines, DIGEST_MAX_LINES, isoWeek, LoadoutScan, postWeeklyLoadoutNote, weeklyNote, type ScanRow,
} from './loadout-notes';
import { KpiDigestService, digestView, type KpiDigest } from '../manager/kpi-digest.service';

const sug = (kind: LoadoutSuggestion['kind'], name: string, action: LoadoutSuggestion['action']): LoadoutSuggestion => ({
  id: `${kind}:${name}`, kind, ...(kind === 'skills_unused' ? { skill: name } : { tool: name }), action, reason: 'r', evidence: {},
});
const row = (handle: string, ...s: LoadoutSuggestion[]): ScanRow => ({ agent: { id: `id-${handle}`, handle }, suggestions: s });

test('one agent, one line: add, remove, skills off', () => {
  assert.equal(
    agentLine(row('ch_executor', sug('missing', 'lint_post', 'add'), sug('peer', 'get_top_posts', 'add'), sug('unused', 'act_x', 'remove'), sug('skills_unused', 'poll', 'disable'))),
    '@ch_executor: add lint_post, get_top_posts · remove act_x · skills off poll',
  );
});

test('the digest block is at most 5 lines: the busiest agents first, the rest counted', () => {
  const rows = [
    row('a', sug('unused', 'x', 'remove')), row('b', sug('unused', 'x', 'remove'), sug('unused', 'y', 'remove')), row('c'),
    ...['d', 'e', 'f', 'g', 'h'].map((h) => row(h, sug('unused', 'x', 'remove'))),
  ];
  const lines = digestLines(rows);
  assert.equal(lines.length, DIGEST_MAX_LINES);
  assert.match(lines[0], /^@b:/);
  assert.equal(lines[4], '…and 3 more agents with loadout suggestions');
  assert.deepEqual(digestLines([row('a')]), [], 'no suggestions, no block');
  assert.equal(digestLines(rows.slice(0, 3)).length, 2);
});

test('isoWeek: the ISO 8601 week of a date', () => {
  assert.equal(isoWeek(new Date('2026-10-20T10:00:00Z')), '2026-W43');
  assert.equal(isoWeek(new Date('2026-01-01T00:00:00Z')), '2026-W01');
  assert.equal(isoWeek(new Date('2027-01-01T00:00:00Z')), '2026-W53');
  assert.equal(isoWeek(new Date('2026-10-25T23:59:00Z')), '2026-W43', 'Sunday belongs to the week that began on Monday');
});

test('weekly note: Ukrainian title with the total, a link to the first agent\'s Loadout tab, info severity; none without suggestions', () => {
  const n = weeklyNote([row('zeta', sug('unused', 'x', 'remove')), row('alpha', sug('missing', 'lint_post', 'add'), sug('stale', 'old', 'remove')), row('quiet')], '2026-W43')!;
  assert.equal(n.title, 'Інструменти агентів: 3 пропозиції');
  assert.deepEqual([n.kind, n.severity, n.refType, n.refId, n.agentId], ['loadout_suggestions', 'info', 'loadout', '2026-W43', 'id-alpha']);
  assert.match(n.body!, /\/app\/agents\/alpha\?tab=loadout/);
  assert.match(n.body!, /@zeta: remove x/);
  assert.equal(weeklyNote([row('quiet')], '2026-W43'), null);
  assert.equal(weeklyNote([row('a', sug('unused', 'x', 'remove'))], 'w')!.title, 'Інструменти агентів: 1 пропозиція');
  assert.equal(weeklyNote([row('a', ...Array.from({ length: 5 }, (_, i) => sug('unused', `x${i}`, 'remove')))], 'w')!.title, 'Інструменти агентів: 5 пропозицій');
});

const agent = (handle: string, kind: string = 'executor'): Agent => ({ id: `id-${handle}`, handle, kind } as Agent);

test('scan: every agent that has a loadout, one failing agent skipped, reused within the ttl', async () => {
  let viewed = 0;
  let clock = 0;
  const scan = new LoadoutScan({
    agents: { list: async () => [agent('a'), agent('bad'), agent('q'), agent('boss', 'manager')] },
    admin: {
      viewOf: async (a: Agent) => {
        viewed++;
        if (a.handle === 'bad') throw new Error('db');
        return { suggestions: a.handle === 'q' ? [] : [sug('unused', 'x', 'remove')] } as any;
      },
    },
    ttlMs: 1000, now: () => clock,
  });
  assert.deepEqual((await scan.run()).map((r) => r.agent.handle), ['a', 'boss']);
  await scan.run();
  assert.equal(viewed, 4, 'the second run came from the cache');
  clock = 5000;
  await scan.run();
  assert.equal(viewed, 8);
  await scan.run(true);
  assert.equal(viewed, 12, 'fresh bypasses the cache');
  assert.deepEqual(await scan.digestLines(), ['@a: remove x', '@boss: remove x']);
});

test('weekly post: once per ISO week through postOnce, nothing without suggestions', async () => {
  const posted: any[] = [];
  const seen = new Set<string>();
  const inbox = { postOnce: async (i: any) => { const k = `${i.kind}|${i.refType}|${i.refId}`; if (seen.has(k)) return null; seen.add(k); posted.push(i); return posted.length; } };
  const scan = { run: async () => [row('a', sug('unused', 'x', 'remove'))] };
  const now = new Date('2026-10-19T09:30:00Z');
  assert.equal(await postWeeklyLoadoutNote({ scan, inbox }, now), true);
  assert.equal(await postWeeklyLoadoutNote({ scan, inbox }, new Date('2026-10-21T09:30:00Z')), false, 'same ISO week');
  assert.equal(await postWeeklyLoadoutNote({ scan, inbox }, new Date('2026-10-26T09:30:00Z')), true, 'next week');
  assert.equal(await postWeeklyLoadoutNote({ scan: { run: async () => [] }, inbox }, new Date('2026-11-02T09:30:00Z')), false);
  assert.deepEqual(posted.map((p) => p.refId), ['2026-W43', '2026-W44']);
});

// ── the digest block ─────────────────────────────────────────────────────────

const baseDigest = (loadout?: string[]): KpiDigest => ({
  generatedAt: '2026-10-20T10:00:00Z', today: '2026-10-20', resources: [], agents: [],
  budget: { spentTodayUsd: 0, capUsd: 3 }, directives: { open: [], outcomes: [] }, hash: 'h', raw: new Map(),
  ...(loadout ? { loadout } : {}),
});

test('digest view: the loadout block is there when there are lines, and not otherwise', () => {
  const withLines = JSON.parse(digestView(baseDigest(['@a: remove x'])).text);
  assert.deepEqual(withLines.loadout, ['@a: remove x']);
  assert.ok(!('loadout' in JSON.parse(digestView(baseDigest()).text)));
  assert.ok(typeof KpiDigestService === 'function');
});
