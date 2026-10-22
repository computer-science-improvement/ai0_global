/**
 * Spec 060 FR-005 / T4: the manager sees whether advice was followed. The digest's open list and the prompt text carry
 * adherence and age; the review signature does not count a not-followed or overdue directive as cover and is forced by a
 * dark day, a paused series or a critic streak; the prompt says what to do with advice nobody followed; a metric that
 * cannot be measured is refused; a directive that was not followed or not judged leaves a lesson. No LLM, no database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audienceCaps } from '../post/audience-asks';
import { assembleQuality } from './quality-digest';
import { countsAsCover, digestHash, KpiDigestService, reviewSignature, type KpiDigest } from './kpi-digest.service';
import { managerSystemPrompt, NOT_FOLLOWED_LINES, openDirectivesText } from './manager-runner';
import { fileDirective } from './directive-tools';

const NOW = '2026-10-22T10:00:00Z';
const NOW_MS = Date.parse(NOW);
const res = (flags: string[], signals?: Array<'series_paused' | 'critic_streak'>) =>
  [{ ref: 'telegram:@space', agent: 'kira', anomalies: [], quality: { flags }, ...(signals ? { signals } : {}) }] as any;
const dir = (o: Record<string, unknown> = {}) => ({ id: 'x', to: 'kira', kind: 'voice_fix', status: 'accepted', body: 'b', createdAt: '', ...o }) as any;
const sig = (flags: string[], open: any[], signals?: Array<'series_paused' | 'critic_streak'>) => reviewSignature({ resources: res(flags, signals), directives: { open }, generatedAt: NOW });

test('open directives: the prompt text shows whether the advice was followed and how old it is', () => {
  const text = openDirectivesText([
    dir({ id: 'a', status: 'applied', binding: 'advice', adherence: 'not_followed', ageDays: 6, reviewAt: '2026-10-25T00:00:00Z' }),
    dir({ id: 'b', status: 'accepted', adherence: null, ageDays: 0 }),
    dir({ id: 'c', status: 'new' }),
  ]);
  const [a, b, c] = text.split('\n');
  assert.match(a, /applied · виконання not_followed · 6 дн\. · перевірка 2026-10-25 · id a/);
  assert.match(b, /accepted · 0 дн\. · перевірка — · id b/);
  assert.doesNotMatch(c, /виконання|дн\./, 'a directive without those facts reads as before');
  assert.equal(openDirectivesText([]), '- немає');
});

test('cover: not_followed applied and overdue accepted cover nothing; a live one does', () => {
  assert.equal(countsAsCover({ status: 'applied', adherence: 'not_followed', reviewAt: null }, NOW_MS), false);
  assert.equal(countsAsCover({ status: 'applied', adherence: 'followed', reviewAt: null }, NOW_MS), true);
  assert.equal(countsAsCover({ status: 'accepted', adherence: null, reviewAt: '2026-10-20T00:00:00Z' }, NOW_MS), false, 'past its review date');
  assert.equal(countsAsCover({ status: 'accepted', adherence: null, reviewAt: '2026-10-25T00:00:00Z' }, NOW_MS), true);
  assert.equal(countsAsCover({ status: 'accepted', adherence: null, reviewAt: null }, NOW_MS), true);
  assert.equal(countsAsCover({ status: 'new', adherence: null, reviewAt: '2026-10-01T00:00:00Z' }, NOW_MS), true, 'only accepted ones age out');
});

test('signature: flags of an agent covered by a followed / live directive do not change it (as in spec 046)', () => {
  const live = [dir({ status: 'applied', adherence: 'followed' }), dir({ id: 'y', status: 'accepted', reviewAt: '2026-10-25T00:00:00Z' })];
  assert.equal(sig(['critic_reject'], live), sig([], live));
});

test('signature: an applied directive that was not followed does not cover; neither does an accepted one past its review date', () => {
  for (const open of [
    [dir({ status: 'applied', adherence: 'not_followed' })],
    [dir({ status: 'accepted', reviewAt: '2026-10-20T00:00:00Z' })],
  ]) {
    assert.notEqual(sig(['critic_reject'], open), sig([], open));
    // ...and it is the same as having no directive at all.
    assert.equal(sig(['critic_reject'], open), sig(['critic_reject'], []));
  }
  // One followed directive among them still covers.
  assert.equal(sig(['critic_reject'], [dir({ status: 'applied', adherence: 'not_followed' }), dir({ id: 'z', status: 'applied', adherence: 'followed' })]), sig([], []));
});

test('signature: a dark day, a paused series and a critic streak force a review even when covered', () => {
  const covered = [dir({ status: 'applied', adherence: 'followed' })];
  assert.notEqual(sig(['dark_day'], covered), sig([], covered));
  assert.notEqual(sig([], covered, ['series_paused']), sig([], covered));
  assert.notEqual(sig([], covered, ['critic_streak']), sig([], covered));
  assert.notEqual(sig([], covered, ['series_paused']), sig([], covered, ['critic_streak']));
  // Other flags stay covered next to a dark day.
  assert.equal(sig(['dark_day', 'critic_reject'], covered), sig(['dark_day'], covered));
});

test('signature: a resource without signals hashes as before (no extra review at deploy)', () => {
  const plain = reviewSignature({ resources: res(['critic_reject']) });
  assert.equal(reviewSignature({ resources: res(['critic_reject'], []) }), plain);
  assert.equal(digestHash({ resources: res([]).map((r: any) => ({ ...r, kpis: {} })), directives: { open: [], outcomes: [] } }),
    digestHash({ resources: res([], []).map((r: any) => ({ ...r, kpis: {} })), directives: { open: [], outcomes: [] } }));
  const withSignal = { resources: res([], ['series_paused']).map((r: any) => ({ ...r, kpis: {} })), directives: { open: [], outcomes: [] } } as any;
  const without = { resources: res([]).map((r: any) => ({ ...r, kpis: {} })), directives: { open: [], outcomes: [] } } as any;
  assert.notEqual(digestHash(withSignal), digestHash(without), 'a new pause changes the digest hash, so the hash skip does not hide it');
});

test('digest: paused series and a critic streak of 3 or more become signals of their resource (best effort)', async () => {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('FROM series_pauses')) return { rows: [{ channel_key: '@space' }, { channel_key: '@other' }] };
      if (sql.includes('FROM agent_inbox')) {
        return { rows: [
          { subject: 'silent:telegram:@space:critic', parts: ['streak:4'] },
          { subject: 'silent:telegram:@calm:critic', parts: ['streak:2'] },
          { subject: 'silent:telegram:@other:critic', parts: null },
        ] };
      }
      return { rows: [] };
    },
  };
  const svc = new KpiDigestService({ pool, catalog: { list: async () => [] }, globalCapUsd: 3 } as any);
  const got = await (svc as any).signalsOf() as Map<string, string[]>;
  assert.deepEqual([...got.entries()].sort(), [['telegram:@other', ['series_paused']], ['telegram:@space', ['series_paused', 'critic_streak']]]);
  const broken = new KpiDigestService({ pool: { query: async () => { throw new Error('relation does not exist'); } }, catalog: { list: async () => [] }, globalCapUsd: 3 } as any);
  assert.equal(((await (broken as any).signalsOf()) as Map<string, unknown>).size, 0, 'an unmigrated database means no signals, not a failed digest');
});

test('prompt: advice nobody followed is re-filed as a directive, twice means the owner; a paused series is not advised again', () => {
  const prompt = managerSystemPrompt({ agent: { name: 'Manager', handle: 'manager' } as any, now: new Date(NOW), digest: '{}', memory: '', skills: { inline: '', listed: '' }, open: [] });
  for (const line of NOT_FOLLOWED_LINES) assert.ok(prompt.includes(line));
  assert.match(NOT_FOLLOWED_LINES[0], /not_followed/);
  assert.match(NOT_FOLLOWED_LINES[0], /binding: directive.*supersedes/);
  assert.match(NOT_FOLLOWED_LINES[0], /двічі.*власнику.*структурна/);
  assert.match(NOT_FOLLOWED_LINES[1], /series_paused.*не радь/);
});

// ── an unmeasurable expected metric ───────────────────────────────────────

function fileDeps() {
  return {
    repo: {
      openFor: async () => null, appliedFor: async () => null, lastRejected: async () => null, countForRun: async () => 0, countOpenBinding: async () => 0, lastDeclinedAdvice: async () => null,
      insert: async (x: any) => ({ id: 'd1', ...x }), update: async () => null,
    } as any,
    agents: { getByHandle: async () => ({ id: 'o1', handle: 'kira', kind: 'orchestrator', parentId: null }), findTop: async () => null } as any,
    digest: { build: async () => ({}) as any, render: () => '{}' }, inbox: { post: async () => 1 }, memory: { listActive: async () => [] }, actions: { propose: async () => ({}) as any },
    channelKeyOf: async () => '@space',
  };
}

function digestWith(owner: { approved: number; rejected: number }): KpiDigest {
  const base = assembleQuality({ critic: [], posts: [], owner: [], caps: audienceCaps(null) });
  const q = { ...base, owner: { ...base.owner, approved: owner.approved, rejected: owner.rejected, rejection_rate: owner.approved + owner.rejected ? Math.round((owner.rejected / (owner.approved + owner.rejected)) * 100) : null } };
  return {
    generatedAt: NOW, today: '2026-10-22', agents: [], budget: { spentTodayUsd: 0, capUsd: 3 }, directives: { open: [], outcomes: [] }, hash: '', raw: new Map(),
    resources: [{ ref: 'telegram:@space', title: 'Space', agent: 'kira', health: 'ok', kpis: { views_per_post: { v: 100 } } as any, anomalies: [], quality: q }],
  };
}

const input = (metric: string) => ({
  to: '@kira', kind: 'voice_fix' as const, binding: 'advice' as const, body: 'Прибрати штампи й жарти з постів @space', params: { resource_ref: 'telegram:@space', rules: ['Без звертань «друзі» і без «давайте розберемося»'] },
  rationale: 'Власник відхилив 2 пости через штампи, критик відхилив ще один', evidence: { owner_rejected: 2 },
  expected: { metric: metric as any, direction: 'down' as const, min_change_pct: 20, resource_ref: 'telegram:@space' }, review_in_days: 7,
});

test('file_directive: owner_rejection_rate / owner_edit_rate with 0 owner approvals in 7 days is refused with a remedy', async () => {
  const none = digestWith({ approved: 0, rejected: 2 });
  for (const metric of ['owner_rejection_rate', 'owner_edit_rate']) {
    const r: any = await fileDirective(fileDeps(), input(metric), { from: null, runId: null, shadow: false, digest: none });
    assert.equal(r.error, 'unmeasurable_metric', metric);
    assert.match(r.details, /не схвалив жодного поста за 7 днів/);
    assert.match(r.details, /critic_pass_rate|advice|пораду/, 'the remedy names what to do instead');
  }
});

test('file_directive: with approvals the owner rate is accepted; other metrics are not affected by 0 approvals', async () => {
  const some = digestWith({ approved: 3, rejected: 2 });
  const ok: any = await fileDirective(fileDeps(), input('owner_rejection_rate'), { from: null, runId: null, shadow: false, digest: some });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const none = digestWith({ approved: 0, rejected: 2 });
  const critic: any = await fileDirective(fileDeps(), input('critic_pass_rate'), { from: null, runId: null, shadow: false, digest: { ...none, resources: none.resources.map((r) => ({ ...r, quality: { ...r.quality!, critic: { ...r.quality!.critic, pass_rate: 50, total: 4, pass: 2, reject: 2 } } })) } });
  assert.notEqual(critic.error, 'unmeasurable_metric');
});
