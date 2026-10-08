import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitDirective, checkBinding, ESCALATION_MIN_MOVE_PCT, KIND_BINDING, MAX_OPEN_BINDING, metricAnomaly, metricValue, moveSince, paramStructural } from './directive-kinds';
import { fileDirective } from './directive-tools';
import { bindingLabel, ManagerRunner } from './manager-runner';
import { ManagerService } from './manager.service';
import { DIRECTIVE_KINDS, DirectiveKind } from './directives.repository';

// ── FR-002: kind × binding matrix ───────────────────────────────────────────

/** Expected outcome of every cell: kind × binding × (structural by params?). */
const CELLS: Array<[DirectiveKind, Record<string, unknown>, 'directive' | 'advice', string | null]> = [
  ['advice', {}, 'advice', null],
  ['advice', {}, 'directive', 'advice_kind_is_advice'],
  ...(['task', 'format_shift', 'pause_series', 'experiment', 'repost'] as DirectiveKind[]).flatMap((k): Array<[DirectiveKind, Record<string, unknown>, 'directive' | 'advice', string | null]> => [
    [k, {}, 'advice', null],
    [k, {}, 'directive', null],
  ]),
  ['frequency', { change_pct: -20 }, 'advice', null],
  ['frequency', { change_pct: 29 }, 'directive', null],
  ['frequency', { change_pct: 30 }, 'advice', 'structural_must_be_directive'],
  ['frequency', { change_pct: -45 }, 'advice', 'structural_must_be_directive'],
  ['frequency', { change_pct: 30 }, 'directive', null],
  ...(['cross_promo', 'pause_resource', 'strategy'] as DirectiveKind[]).flatMap((k): Array<[DirectiveKind, Record<string, unknown>, 'directive' | 'advice', string | null]> => [
    [k, {}, 'advice', 'structural_must_be_directive'],
    [k, {}, 'directive', null],
  ]),
  ['format_shift', { add_platform: 'tiktok' }, 'advice', 'structural_must_be_directive'],
];

test('matrix: every kind has a binding rule', () => {
  assert.deepEqual(Object.keys(KIND_BINDING).sort(), [...DIRECTIVE_KINDS].sort());
  for (const k of DIRECTIVE_KINDS) assert.ok(CELLS.some((c) => c[0] === k && c[2] === 'advice') && CELLS.some((c) => c[0] === k && c[2] === 'directive'), k);
});

test('matrix: each cell', () => {
  for (const [kind, params, binding, err] of CELLS) {
    const r = checkBinding(kind, binding, paramStructural(kind, params));
    assert.equal(r?.error ?? null, err, `${kind} ${JSON.stringify(params)} as ${binding}`);
    if (r) assert.ok(r.details.length > 10);
  }
  // A dry-run can make a non-structural kind structural (a format added): then advice is refused too.
  assert.equal(checkBinding('format_shift', 'advice', true)?.error, 'structural_must_be_directive');
  assert.equal(checkBinding('pause_series', 'directive', true), null);
});

test('structural params: always-structural kinds, ±30 % frequency, a new platform', () => {
  for (const k of ['cross_promo', 'pause_resource', 'strategy'] as DirectiveKind[]) assert.equal(paramStructural(k, {}), true);
  assert.equal(paramStructural('frequency', { change_pct: -30 }), true);
  assert.equal(paramStructural('frequency', { change_pct: 29.9 }), false);
  assert.equal(paramStructural('task', { add_platform: 'x' }), true);
  assert.equal(paramStructural('format_shift', {}), false);
});

// ── FR-003: admission ───────────────────────────────────────────────────────

const dg = (o: { anomaly?: boolean; v?: number | null; ref?: string } = {}) => ({
  resources: [
    { ref: o.ref ?? 'telegram:@space', title: null, agent: 'kira', health: null, kpis: { views_per_post: { v: o.v ?? 1000, base: 1200, d: -16, z: -1 } } as any, anomalies: o.anomaly ? ['views_per_post'] : [] },
    { ref: 'telegram:@other', title: null, agent: 'olga', health: null, kpis: { views_per_post: { v: 50, base: 50, d: 0, z: 0 } } as any, anomalies: ['views_per_post'] },
  ],
});
const EXP = { metric: 'views_per_post' as const, direction: 'up' as const, min_change_pct: 10 };
const base = { binding: 'directive' as const, structural: false, ownerApproved: false, targetHandle: 'kira', expected: EXP, declined: null, openBinding: 0 };

test('admission: advice always; a binding directive needs an anomaly in the target scope', () => {
  assert.deepEqual(admitDirective({ ...base, binding: 'advice', digest: dg() }), { ok: true, basis: 'advice' });
  assert.equal((admitDirective({ ...base, digest: dg() }) as any).error, 'directive_needs_anomaly');
  assert.equal((admitDirective({ ...base, digest: dg({ anomaly: true }) }) as any).basis, 'anomaly');
  // Another agent's anomaly does not count; a resource_ref scope picks that resource only.
  assert.equal((admitDirective({ ...base, digest: dg({ ref: 'telegram:@space' }), expected: { ...EXP, resource_ref: 'telegram:@space' } }) as any).error, 'directive_needs_anomaly');
  assert.equal((admitDirective({ ...base, digest: dg(), expected: { ...EXP, resource_ref: 'telegram:@other' } }) as any).basis, 'anomaly');
  assert.equal((admitDirective({ ...base, digest: null }) as any).error, 'directive_needs_anomaly');
  assert.equal((admitDirective({ ...base, expected: null, digest: dg({ anomaly: true }) }) as any).error, 'directive_needs_anomaly', 'a task directive without expected has no anomaly basis');
  assert.match((admitDirective({ ...base, digest: dg() }) as any).details, /advice/);
});

test('admission: escalation after a declined advice when the metric moved further against expected', () => {
  const declined = (filedValue: number | null, metric = 'views_per_post') => ({ id: 'adv1', expected: { ...EXP, metric: metric as any }, filedValue });
  const ok = admitDirective({ ...base, digest: dg({ v: 900 }), declined: declined(1000) }) as any;
  assert.equal(ok.basis, 'escalation');
  assert.equal(ok.detail.declined_advice, 'adv1');
  assert.equal(ok.detail.move_pct, -10);
  // Moved the right way, or too little, or another metric, or no baseline → not an escalation.
  assert.equal((admitDirective({ ...base, digest: dg({ v: 1100 }), declined: declined(1000) }) as any).error, 'directive_needs_anomaly');
  assert.equal((admitDirective({ ...base, digest: dg({ v: 1000 - ESCALATION_MIN_MOVE_PCT * 10 + 1 }), declined: declined(1000) }) as any).error, 'directive_needs_anomaly');
  assert.equal((admitDirective({ ...base, digest: dg({ v: 900 }), declined: declined(1000, 'posts') }) as any).error, 'directive_needs_anomaly');
  assert.equal((admitDirective({ ...base, digest: dg({ v: 900 }), declined: declined(null) }) as any).error, 'directive_needs_anomaly');
  // "down" expectations: a rise is "further against".
  assert.equal(moveSince({ id: 'a', expected: { ...EXP, direction: 'down' }, filedValue: 100 }, { ...EXP, direction: 'down' }, 120), -20);
});

test('admission: structural directives skip the anomaly rule; the owner skips everything; ≤ 2 open binding per target', () => {
  assert.equal((admitDirective({ ...base, structural: true, digest: dg() }) as any).basis, 'structural');
  assert.equal((admitDirective({ ...base, ownerApproved: true, digest: null, openBinding: 5 }) as any).basis, 'owner');
  assert.equal((admitDirective({ ...base, digest: dg({ anomaly: true }), openBinding: MAX_OPEN_BINDING }) as any).error, 'binding_limit');
  assert.equal((admitDirective({ ...base, structural: true, digest: dg(), openBinding: MAX_OPEN_BINDING }) as any).error, 'binding_limit');
  assert.equal((admitDirective({ ...base, binding: 'advice', digest: dg(), openBinding: 9 }) as any).basis, 'advice', 'advice is not limited');
});

test('digest helpers: scope value and anomaly', () => {
  assert.equal(metricValue(dg({ v: 800 }), 'kira', 'views_per_post'), 800);
  assert.equal(metricValue(dg(), 'nobody', 'views_per_post'), null);
  assert.equal(metricAnomaly(dg({ anomaly: true }), 'kira', 'views_per_post'), true);
  assert.equal(metricAnomaly(dg({ anomaly: true }), 'kira', 'posts'), false);
});

// ── fileDirective with the matrix and admission ────────────────────────────

const ORCH = { id: 'o1', handle: 'kira', kind: 'orchestrator', parentId: null, mode: 'live' } as any;
function setup(o: { openBinding?: number; declined?: any } = {}) {
  const inserted: any[] = [];
  const inbox: any[] = [];
  const repo = {
    openFor: async () => null, lastRejected: async () => null, countForRun: async () => 0,
    countOpenBinding: async () => o.openBinding ?? 0, lastDeclinedAdvice: async () => o.declined ?? null,
    insert: async (d: any) => { const x = { id: `d${inserted.length + 1}`, ...d, createdAt: new Date() }; inserted.push(x); return x; },
    update: async (id: string, p: any) => ({ id, ...p }),
  } as any;
  const deps = {
    repo, agents: { getByHandle: async (h: string) => (h.replace('@', '') === 'kira' ? ORCH : null), findTop: async () => null } as any,
    digest: { build: async () => dg() as any, render: () => '{}' }, inbox: { post: async (i: any) => { inbox.push(i); return 1; } },
    memory: { listActive: async () => [] as any }, actions: { propose: async () => ({}) as any }, channelKeyOf: async () => '@space',
  };
  return { deps, inserted, inbox };
}
const input = (over: Record<string, unknown> = {}) => ({
  to: '@kira', kind: 'format_shift' as DirectiveKind, binding: 'directive' as 'directive' | 'advice', body: 'Більше каруселей в Instagram',
  params: { format: 'ig_carousel', weight_delta: 0.2 } as Record<string, unknown>,
  rationale: 'Каруселі дають на 60% більше переглядів за 28 днів', evidence: { views_per_post: 1000 },
  expected: EXP as typeof EXP | undefined, review_in_days: 7, ...over,
} as any);

test('fileDirective: binding directive without an anomaly → directive_needs_anomaly; as advice → filed with binding advice', async () => {
  const s = setup();
  assert.equal(((await fileDirective(s.deps, input(), { from: null, runId: 'r', shadow: false, digest: dg() as any })) as any).error, 'directive_needs_anomaly');
  const r: any = await fileDirective(s.deps, input({ binding: 'advice' }), { from: null, runId: 'r', shadow: false, digest: dg() as any });
  assert.equal(r.ok, true);
  assert.equal(s.inserted[0].binding, 'advice');
  assert.deepEqual(s.inserted[0].outcomeDetail.at_filing, { metric: 'views_per_post', value: 1000 });
  assert.equal(s.inserted[0].outcomeDetail.admission.basis, 'advice');
});

test('fileDirective: anomaly and escalation paths store their basis; the digest is built when not passed', async () => {
  const a = setup();
  const ra: any = await fileDirective(a.deps, input(), { from: null, runId: 'r', shadow: false, digest: dg({ anomaly: true }) as any });
  assert.equal(ra.ok, true);
  assert.equal(a.inserted[0].binding, 'directive');
  assert.equal(a.inserted[0].outcomeDetail.admission.basis, 'anomaly');
  const e = setup({ declined: { id: 'adv1', expected: EXP, outcomeDetail: { at_filing: { metric: 'views_per_post', value: 1200 } } } });
  const re: any = await fileDirective(e.deps, input(), { from: null, runId: 'r', shadow: false });
  assert.equal(re.ok, true, JSON.stringify(re));
  assert.equal(e.inserted[0].outcomeDetail.admission.basis, 'escalation');
  assert.equal(e.inserted[0].outcomeDetail.admission.declined_advice, 'adv1');
});

test('fileDirective: matrix errors, binding limit, owner-approved bypass', async () => {
  const s = setup();
  const o = { from: null, runId: 'r', shadow: false, digest: dg({ anomaly: true }) as any };
  assert.equal(((await fileDirective(s.deps, input({ kind: 'advice', expected: undefined }), o)) as any).error, 'advice_kind_is_advice');
  assert.equal(((await fileDirective(s.deps, input({ kind: 'cross_promo', binding: 'advice', params: {} }), o)) as any).error, 'structural_must_be_directive');
  assert.equal(((await fileDirective(s.deps, input({ kind: 'frequency', binding: 'advice', params: { change_pct: -40 } }), o)) as any).error, 'structural_must_be_directive');
  assert.equal(((await fileDirective(setup({ openBinding: 2 }).deps, input(), o)) as any).error, 'binding_limit');
  const owner = setup({ openBinding: 2 });
  const r: any = await fileDirective(owner.deps, input(), { from: null, runId: null, shadow: false, ownerApproved: true });
  assert.equal(r.ok, true);
  assert.equal(owner.inserted[0].outcomeDetail.admission.basis, 'owner');
  // A structural directive goes to the owner whatever the anomaly says.
  const st = setup();
  const rs: any = await fileDirective(st.deps, input({ kind: 'frequency', params: { change_pct: -40 } }), { from: null, runId: 'r', shadow: false, digest: dg() as any });
  assert.equal(rs.directive.status, 'awaiting_owner');
  assert.equal(st.inbox.length, 1);
});

// ── FR-017 / FR-018 read part ──────────────────────────────────────────────

test('delivered text marks directives and advice', async () => {
  assert.equal(bindingLabel({ binding: 'directive' }), 'ДИРЕКТИВА (обовʼязково)');
  assert.equal(bindingLabel({ binding: 'advice' }), 'порада (на твій розсуд)');
  const runner = new ManagerRunner({
    loop: { run: async () => ({}) as any }, registry: { forRole: () => [] }, runtime: { forAgent: async () => ({}) as any },
    agents: { findTop: async () => null, get: async () => null, list: async () => [] } as any,
    repo: {
      inbox: async () => [
        { id: 'a', kind: 'format_shift', binding: 'directive', structural: false, body: 'Більше каруселей', rationale: 'r', expected: null, params: {} },
        { id: 'b', kind: 'advice', binding: 'advice', structural: false, body: 'Спробуй опитування', rationale: 'r', expected: null, params: {} },
      ],
      markDelivered: async () => {},
    } as any,
    digest: { build: async () => ({}) as any, render: () => '', snapshot: async () => 0 }, inbox: { post: async () => 1 }, env: () => undefined,
  });
  const text = (await runner.deliver(ORCH))!;
  assert.match(text, /- ДИРЕКТИВА \(обовʼязково\) · id a · format_shift/);
  assert.match(text, /- порада \(на твій розсуд\) · id b · advice/);
});

test('GET /api/directives filters: binding, kind csv, verified; bad values → 400', async () => {
  const calls: any[] = [];
  const svc = new ManagerService({
    repo: { list: async (f: any) => { calls.push(f); return []; } } as any,
    agents: { getByHandle: async () => null, list: async () => [] } as any,
    digest: {} as any, runner: {} as any,
  });
  await svc.directives({ binding: 'advice', kind: 'format_shift,frequency,bogus', verified: 'false', status: 'contested,applied' });
  assert.equal(calls[0].binding, 'advice');
  assert.deepEqual(calls[0].kinds, ['format_shift', 'frequency']);
  assert.equal(calls[0].verified, false);
  assert.deepEqual(calls[0].status, ['contested', 'applied']);
  await svc.directives({});
  assert.equal(calls[1].binding, null);
  assert.equal(calls[1].kinds, null);
  assert.equal(calls[1].verified, null);
  await assert.rejects(svc.directives({ binding: 'maybe' }), /Bad Request/);
  await assert.rejects(svc.directives({ verified: 'yes' }), /Bad Request/);
  await assert.rejects(svc.directives({ kind: 'bogus' }), /Bad Request/);
});
