import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaybookSchema, type Playbook } from '../../network/playbook';
import {
  DirectiveExecution, formatShiftExecutor, frequencyExecutor, MAX_EXEC_ATTEMPTS, pauseSeriesExecutor, type Change, type ExecContext,
} from '.';
import { holdsIn, revertsIn } from './playbook-change';
import { resumeChange } from './playbook-executors';
import type { ObservedPlan } from './plan-observer';
import { fileDirective } from '../directive-tools';
import { submitPlaybookVersion } from '../../network/series-edit';

const TG = 'telegram:@space';
const IG = 'instagram:42';
const ORCH = { id: 'o1', handle: 'kira', kind: 'orchestrator', parentId: null, mode: 'live', scope: 'resource', scopeId: TG } as any;
const CARD = { channelKey: '@space', mode: 'live', postsPerDayMin: 2, postsPerDayMax: 6, formats: { text: 1, photo: 0.6, poll: 0 }, quietStartHour: 23, quietEndHour: 8 } as any;
const BODY = (): Playbook => PlaybookSchema.parse({
  platforms: [
    { resource_ref: TG, role: 'core', formats: { text: 1, photo: 0.6 }, per_day: { min: 2, max: 5 } },
    { resource_ref: IG, role: 'discovery', formats: { ig_photo: 1, ig_carousel: 0.3 }, per_day: { min: 1, max: 2 } },
  ],
  series: [
    { name: 'Фото дня', cadence: 'daily@10:00', resource_ref: TG, format: 'photo', brief: 'Найкраще фото дня з коротким описом' },
    { name: 'Власницька', cadence: 'daily@12:00', resource_ref: TG, format: 'text', brief: 'Серія, яку заблокував власник', locked: true, origin: 'owner' },
  ],
});
const NOW = new Date('2026-10-20T09:00:00Z');

function ctx(o: { playbook?: Playbook | null; mode?: any; resources?: any[] } = {}): ExecContext {
  const playbook = o.playbook === undefined ? BODY() : o.playbook;
  return {
    orch: ORCH, card: CARD, playbook, mode: o.mode ?? 'live', now: NOW,
    net: {
      orchestrator: ORCH, anchorKey: '@space', groupId: 'g', groupName: 'Space', mode: 'independent', playbook, playbookVersion: 3,
      resources: o.resources ?? [{ ref: TG, platform: 'telegram' }, { ref: IG, platform: 'instagram' }], telegramFormats: ['text', 'photo', 'poll'],
    },
  };
}

/** In-memory playbook + card store with the repositories' semantics (versions, directive_id, no-op). */
function store(initial: Playbook | null = BODY()) {
  const versions: Array<{ id: string; version: number; body: Playbook; createdBy: string; directiveId: string | null }> = initial
    ? [{ id: 'p1', version: 1, body: initial, createdBy: 'owner', directiveId: null }] : [];
  let card = { ...CARD, formats: { ...CARD.formats } };
  const plans: ObservedPlan[] = [];
  const network = {
    activePlaybook: async () => { const v = versions.at(-1); return v ? { ...v, agentId: 'o1', status: 'active' } as any : null; },
    applyDirectivePatch: async (_a: string, directiveId: string, patch: (b: Playbook) => Playbook | null) => {
      const v = versions.at(-1);
      if (!v) return { error: 'no_playbook' as const };
      const next = patch(v.body);
      if (!next) return { noop: true, row: v as any };
      const row = { id: `p${versions.length + 1}`, version: v.version + 1, body: next, createdBy: 'directive', directiveId };
      versions.push(row);
      return { noop: false, row: row as any };
    },
  };
  const channels = {
    get: async () => card,
    patchPlanning: async (_k: string, p: any) => {
      card = { ...card, ...(p.postsPerDayMin != null ? { postsPerDayMin: p.postsPerDayMin } : {}), ...(p.postsPerDayMax != null ? { postsPerDayMax: p.postsPerDayMax } : {}), ...(p.formats ? { formats: p.formats } : {}) };
      return true;
    },
  };
  const observer = {
    plans: async (_k: string, o: { after?: Date; before?: Date; limit: number }) =>
      (o.after ? plans.filter((p) => p.createdAt > o.after!) : plans.filter((p) => p.createdAt < o.before!).reverse()).slice(0, o.limit),
  };
  return { versions, network, channels, observer, plans, card: () => card, deps: { network, channels, observer } as any };
}

const dir = (kind: any, params: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({ id: '00000000-0000-4000-8000-0000000000aa', toAgentId: 'o1', kind, params, binding: 'directive', body: 'b', status: 'accepted', change: null, ...over }) as any;

// ── frequency (FR-010) ──────────────────────────────────────────────────────

test('frequency: scales per_day (rounded, clamped), not_executable for bad params / no change / outside the network', () => {
  const ex = frequencyExecutor(store().deps);
  const c = ex.plan(dir('frequency', { change_pct: 40 }), ctx()) as Change;
  assert.equal(c.op, 'per_day');
  assert.deepEqual([c.target, (c as any).before, (c as any).after], ['playbook', { min: 2, max: 5 }, { min: 3, max: 7 }]);
  assert.equal(c.structural, true, '≥ 30 % is structural after the dry-run too');
  const small = ex.plan(dir('frequency', { change_pct: 20 }), ctx()) as Change;
  assert.deepEqual((small as any).after, { min: 2, max: 6 });
  assert.equal(small.structural, false);
  const down = ex.plan(dir('frequency', { change_pct: -60, resource_ref: IG }), ctx()) as any;
  assert.deepEqual(down.after, { min: 0, max: 1 }, 'max stays ≥ 1');
  for (const p of [{ change_pct: -61 }, { change_pct: 101 }, { change_pct: 0 }, { change_pct: 'x' }]) {
    assert.equal((ex.plan(dir('frequency', p), ctx()) as any).error, 'not_executable', JSON.stringify(p));
  }
  assert.equal((ex.plan(dir('frequency', { change_pct: 10, resource_ref: IG }), ctx()) as any).error, 'not_executable', '1–2 +10 % rounds to no change');
  assert.match((ex.plan(dir('frequency', { change_pct: 20, resource_ref: 'facebook:9' }), ctx()) as any).details, /не в мережі/);
  assert.equal((ex.plan(dir('frequency', { change_pct: 20 }), { ...ctx(), card: null, net: null }) as any).error, 'not_executable');
});

test('frequency: the platform dailyApiCap clamps max', () => {
  const big = BODY();
  big.platforms[1].per_day = { min: 20, max: 24 };
  const c = frequencyExecutor(store().deps).plan(dir('frequency', { change_pct: 100, resource_ref: IG }), ctx({ playbook: big })) as any;
  assert.deepEqual(c.after, { min: 24, max: 24 }, 'clamped to 24 (≤ the instagram cap of 50)');
});

test('frequency: apply writes a directive version, re-apply is a no-op; verify reads the first plan after applied_at', async () => {
  const s = store();
  const ex = frequencyExecutor(s.deps);
  const c = ex.plan(dir('frequency', { change_pct: 20 }), ctx()) as Change;
  const a = await ex.apply(c, dir('frequency', {}));
  assert.deepEqual([a.noop, a.version], [false, 2]);
  assert.equal(s.versions[1].createdBy, 'directive');
  assert.equal(s.versions[1].directiveId, '00000000-0000-4000-8000-0000000000aa');
  assert.deepEqual(s.versions[1].body.platforms[0].per_day, { min: 2, max: 6 });
  assert.deepEqual(s.versions[1].body.series, s.versions[0].body.series, 'only the per_day changed');
  const again = await ex.apply(c, dir('frequency', {}));
  assert.equal(again.noop, true);
  assert.equal(s.versions.length, 2, 'no new version on re-apply');

  const applied = dir('frequency', {}, { status: 'applied', change: c, appliedAt: new Date('2026-10-20T10:00:00Z') });
  assert.deepEqual(await ex.verify(applied), { pending: true });
  s.plans.push({ planDate: '2026-10-21', createdAt: new Date('2026-10-20T20:00:00Z'), slots: [TG, TG, TG, IG].map((ref) => ({ ref, format: 'text', series: null, status: 'planned' })) });
  const v = await ex.verify(applied) as any;
  assert.deepEqual([v.verified, v.adherence, v.detail.slots], [true, 'followed', 3]);
  s.plans[0].slots.push(...[1, 2, 3, 4].map(() => ({ ref: TG, format: 'text', series: null, status: 'planned' })));
  assert.equal(((await ex.verify(applied)) as any).adherence, 'violated');
});

test('frequency: single-channel orchestrator without a playbook edits the card', async () => {
  const s = store(null);
  const ex = frequencyExecutor(s.deps);
  const c = ex.plan(dir('frequency', { change_pct: -20 }), ctx({ playbook: null, resources: [{ ref: TG, platform: 'telegram' }] })) as Change;
  assert.equal(c.target, 'card');
  assert.equal(c.channel_key, '@space');
  assert.deepEqual((c as any).after, { min: 2, max: 5 });
  assert.equal((await ex.apply(c, dir('frequency', {}))).noop, false);
  assert.deepEqual([s.card().postsPerDayMin, s.card().postsPerDayMax], [2, 5]);
  assert.equal((await ex.apply(c, dir('frequency', {}))).noop, true);
  // Without a playbook only the anchor is editable.
  assert.equal((ex.plan(dir('frequency', { change_pct: -20, resource_ref: IG }), ctx({ playbook: null })) as any).error, 'not_executable');
});

// ── format_shift (FR-011) ───────────────────────────────────────────────────

test('format_shift: clamps, keeps one format > 0, refuses formats the platform lacks; a new format is structural', () => {
  const ex = formatShiftExecutor(store().deps);
  const up = ex.plan(dir('format_shift', { resource_ref: IG, format: 'ig_carousel', weight_delta: 0.2 }), ctx()) as any;
  assert.deepEqual([up.before, up.after, up.structural], [0.3, 0.5, false]);
  const tg = ex.plan(dir('format_shift', { format: 'photo', weight_delta: 0.3 }), ctx()) as any;
  assert.equal(tg.resource_ref, TG, 'resource_ref defaults to the Telegram anchor');
  assert.equal(tg.after, 0.9);
  assert.equal((ex.plan(dir('format_shift', { format: 'text', weight_delta: 0.3 }), ctx()) as any).error, 'not_executable', 'already at 1');
  const added = ex.plan(dir('format_shift', { format: 'poll', weight_delta: 0.2 }), ctx()) as any;
  assert.equal(added.structural, true, 'a format added');
  assert.match(added.reasons.join(), /formats/);
  assert.match((ex.plan(dir('format_shift', { resource_ref: IG, format: 'ig_reel', weight_delta: 0.2 }), ctx()) as any).details, /недоступний/);
  assert.match((ex.plan(dir('format_shift', { format: 'album', weight_delta: 0.2 }), ctx()) as any).details, /недоступні/, 'outside the card formats');
  assert.equal((ex.plan(dir('format_shift', { format: 'photo', weight_delta: 0.5 }), ctx()) as any).error, 'not_executable');
  const only = BODY();
  only.platforms[1].formats = { ig_photo: 0.2 };
  assert.match((ex.plan(dir('format_shift', { resource_ref: IG, format: 'ig_photo', weight_delta: -0.3 }), ctx({ playbook: only })) as any).details, /хоча б один/);
});

test('format_shift: apply → playbook version with the change; card fallback; verify over 3 plan days', async () => {
  const s = store();
  const ex = formatShiftExecutor(s.deps);
  const c = ex.plan(dir('format_shift', { resource_ref: IG, format: 'ig_carousel', weight_delta: 0.2 }), ctx()) as Change;
  await ex.apply(c, dir('format_shift', {}));
  assert.equal(s.versions[1].body.platforms[1].formats.ig_carousel, 0.5);
  assert.ok(holdsIn(s.versions[1].body, c));
  const applied = dir('format_shift', {}, { status: 'applied', change: c, appliedAt: new Date('2026-10-20T10:00:00Z') });
  const day = (d: string, fmts: string[]) => s.plans.push({ planDate: d, createdAt: new Date(`${d}T05:00:00Z`), slots: fmts.map((format) => ({ ref: IG, format, series: null, status: 'planned' })) });
  day('2026-10-21', ['ig_photo']);
  assert.equal(((await ex.verify(applied)) as any).pending, true, 'not used yet, < 3 days');
  day('2026-10-22', ['ig_photo']);
  day('2026-10-23', ['ig_photo']);
  assert.equal(((await ex.verify(applied)) as any).adherence, 'not_followed');
  s.plans[2].slots.push({ ref: IG, format: 'ig_carousel', series: null, status: 'planned' });
  assert.equal(((await ex.verify(applied)) as any).adherence, 'followed');

  // Negative delta: the share must drop against the plans before.
  const neg = ex.plan(dir('format_shift', { format: 'photo', weight_delta: -0.3 }), ctx()) as Change;
  const s2 = store();
  const ex2 = formatShiftExecutor(s2.deps);
  const at = new Date('2026-10-20T10:00:00Z');
  const tgDay = (d: string, fmts: string[]) => s2.plans.push({ planDate: d, createdAt: new Date(`${d}T05:00:00Z`), slots: fmts.map((format) => ({ ref: TG, format, series: null, status: 'planned' })) });
  tgDay('2026-10-19', ['photo', 'photo', 'text']);
  for (const d of ['2026-10-21', '2026-10-22', '2026-10-23']) tgDay(d, ['photo', 'text', 'text']);
  const v = await ex2.verify(dir('format_shift', {}, { status: 'applied', change: neg, appliedAt: at })) as any;
  assert.deepEqual([v.adherence, v.detail.share, v.detail.share_before], ['followed', 0.33, 0.67]);

  const sc = store(null);
  const exc = formatShiftExecutor(sc.deps);
  const cc = exc.plan(dir('format_shift', { format: 'poll', weight_delta: 0.2 }), ctx({ playbook: null, resources: [{ ref: TG, platform: 'telegram' }] })) as Change;
  assert.deepEqual([cc.target, cc.structural], ['card', true], 'a card format going from 0 to > 0 is a format added');
  await exc.apply(cc, dir('format_shift', {}));
  assert.equal(sc.card().formats.poll, 0.2);
  assert.equal(sc.card().formats.text, 1, 'other weights untouched');
});

// ── pause_series (FR-012) ───────────────────────────────────────────────────

test('pause_series: plan checks the series and resume_on; apply pauses; verify; resume writes active again', async () => {
  const s = store();
  const ex = pauseSeriesExecutor(s.deps);
  const c = ex.plan(dir('pause_series', { series: 'Фото дня' }), ctx()) as any;
  assert.deepEqual([c.op, c.after, c.resume_on, c.structural], ['series_active', false, '2026-11-03', false]);
  assert.equal((ex.plan(dir('pause_series', { series: 'Фото дня' }), ctx({ mode: 'approve' })) as any).structural, true, 'approval mode: every schedule change goes to the owner');
  assert.match((ex.plan(dir('pause_series', { series: 'Нема' }), ctx()) as any).details, /немає/);
  assert.match((ex.plan(dir('pause_series', { series: 'Власницька' }), ctx()) as any).details, /власник/);
  assert.equal((ex.plan(dir('pause_series', { series: 'Фото дня', resume_on: '2026-10-20' }), ctx()) as any).error, 'not_executable');
  assert.equal((ex.plan(dir('pause_series', { series: 'Фото дня', resume_on: '2026-11-18' }), ctx()) as any).error, 'not_executable', '> 28 days');
  assert.equal((ex.plan(dir('pause_series', { name: 'Фото дня', resume_on: '2026-11-17' }), ctx()) as any).resume_on, '2026-11-17');
  assert.equal((ex.plan(dir('pause_series', { series: 'Фото дня' }), ctx({ playbook: null })) as any).error, 'not_executable');

  await ex.apply(c, dir('pause_series', {}));
  assert.equal(s.versions[1].body.series[0].active, false);
  const paused = PlaybookSchema.parse(s.versions[1].body);
  assert.equal((ex.plan(dir('pause_series', { series: 'Фото дня' }), ctx({ playbook: paused })) as any).error, 'not_executable', 'already paused');

  const applied = dir('pause_series', {}, { status: 'applied', change: c, appliedAt: new Date('2026-10-20T10:00:00Z') });
  s.plans.push({ planDate: '2026-10-21', createdAt: new Date('2026-10-20T20:00:00Z'), slots: [{ ref: TG, format: 'photo', series: null, status: 'planned' }] });
  assert.equal(((await ex.verify(applied)) as any).adherence, 'followed');
  s.plans[0].slots.push({ ref: TG, format: 'photo', series: 'Фото дня', status: 'planned' });
  assert.equal(((await ex.verify(applied)) as any).adherence, 'violated');

  const back = resumeChange(c)!;
  await ex.apply(back, dir('pause_series', {}));
  assert.equal(s.versions[2].body.series[0].active, true);
  assert.equal(s.versions[2].directiveId, '00000000-0000-4000-8000-0000000000aa');
});

// ── directive_lock ──────────────────────────────────────────────────────────

test('revertsIn: going back is a revert, going further is not', () => {
  const freq = { op: 'per_day', resource_ref: TG, before: { min: 2, max: 5 }, after: { min: 3, max: 7 } } as any;
  const b = BODY();
  b.platforms[0].per_day = { min: 3, max: 7 };
  assert.equal(revertsIn(b, freq), false);
  b.platforms[0].per_day = { min: 3, max: 8 };
  assert.equal(revertsIn(b, freq), false);
  b.platforms[0].per_day = { min: 2, max: 7 };
  assert.equal(revertsIn(b, freq), true);
  const fmt = { op: 'format_weight', resource_ref: TG, format: 'photo', before: 0.6, after: 0.3 } as any;
  b.platforms[0].formats = { text: 1, photo: 0.2 };
  assert.equal(revertsIn(b, fmt), false);
  b.platforms[0].formats = { text: 1, photo: 0.5 };
  assert.equal(revertsIn(b, fmt), true);
  const ser = { op: 'series_active', series: 'Фото дня', before: true, after: false } as any;
  assert.equal(revertsIn(BODY(), ser), true);
  assert.equal(revertsIn({ ...BODY(), series: [] }, ser), false, 'removing a paused series is not a revert');
});

test('directive_lock: submit_playbook cannot undo a binding directive before review; advice and other changes pass', async () => {
  const lockRow = { id: 'dddd1111-0000-4000-8000-000000000001', kind: 'format_shift', reviewAt: new Date('2026-10-27T00:00:00Z'),
    change: { op: 'format_weight', target: 'playbook', resource_ref: TG, format: 'photo', before: 0.6, after: 0.9, reasons: [] } };
  const exec = new DirectiveExecution({
    repo: { playbookLocks: async () => [lockRow] } as any, inbox: { post: async () => 1 }, agents: { get: async () => null } as any,
    context: async () => null, executors: [], now: () => NOW,
  });
  const inserted: any[] = [];
  const deps = {
    repo: { pendingPlaybook: async () => null, insertPlaybook: async (p: any) => { inserted.push(p); return { id: 'n', version: 9, ...p }; } } as any,
    inbox: { post: async () => 1 },
    directiveLock: (orchId: string, body: Playbook) => exec.lockFor(orchId, body),
  };
  const active = BODY();
  active.platforms[0].formats.photo = 0.9;
  const net = { ...ctx().net!, playbook: active };
  const toolCtx = { runId: 'r', role: 'orchestrator', channelKey: '@space', extras: { card: CARD } } as any;
  const revert = PlaybookSchema.parse(active);
  revert.platforms[0].formats.photo = 0.6;
  const r: any = await submitPlaybookVersion(deps, net, toolCtx, revert, 'Повертаю вагу фото назад, бо так звичніше');
  assert.equal(r.error, 'directive_lock');
  assert.match(r.details, /dddd1111/);
  assert.equal(inserted.length, 0);
  const other = PlaybookSchema.parse(active);
  other.platforms[0].best_hours = [9, 18];
  assert.equal(((await submitPlaybookVersion(deps, net, toolCtx, other, 'Додаю найкращі години публікацій')) as any).ok, true);
});

// ── DirectiveExecution: apply, retries, failed, fallbacks ──────────────────

function execSetup(o: { executors?: any[]; context?: any } = {}) {
  const rows = new Map<string, any>();
  const inbox: any[] = [];
  const repo = {
    get: async (id: string) => rows.get(id) ?? null,
    acceptedForExecution: async (f: { except?: string[] } = {}) => [...rows.values()].filter((r) => r.status === 'accepted' && !(f.except ?? []).includes(r.kind)),
    setChange: async (id: string, c: any) => { rows.get(id).change = c; },
    execFailed: async (id: string, e: string) => { const r = rows.get(id); r.execAttempts = (r.execAttempts ?? 0) + 1; r.execError = e; return r.execAttempts; },
    markApplied: async (id: string, p: any) => { const r = rows.get(id); if (r.status !== 'accepted') return null; Object.assign(r, { status: 'applied', appliedAt: new Date('2026-10-20T10:00:00Z'), ...(p.change ? { change: p.change } : {}), ...(p.verification ? { verification: p.verification } : {}) }); return r; },
    markFailed: async (id: string, e: string) => { const r = rows.get(id); Object.assign(r, { status: 'failed', execError: e }); return r; },
    awaitingVerification: async (kinds: string[]) => [...rows.values()].filter((r) => r.status === 'applied' && kinds.includes(r.kind) && !r.verification?.adherence),
    setVerification: async (id: string, v: any, ok: boolean) => { const r = rows.get(id); r.verification = { ...(r.verification ?? {}), ...v }; if (ok) r.verifiedAt = new Date(); },
    dueSeriesResumes: async () => [], mergeChange: async () => {}, playbookLocks: async () => [],
  };
  const exec = new DirectiveExecution({
    repo: repo as any, inbox: { post: async (i: any) => { inbox.push(i); return 1; } }, agents: { get: async () => ORCH } as any,
    context: o.context ?? (async () => ctx()), executors: o.executors ?? [], now: () => NOW,
  });
  const add = (r: any) => { rows.set(r.id, { status: 'accepted', binding: 'directive', change: null, execAttempts: 0, body: 'b', toAgentId: 'o1', params: {}, ...r }); return rows.get(r.id); };
  return { exec, rows, inbox, add };
}

test('execution: accepted format_shift → applied with the change (before/after, version); advice self-reported; pause_resource (T4) unverified; a task waits for its report', async () => {
  const s = store();
  const x = execSetup({ executors: [formatShiftExecutor(s.deps)] });
  x.add({ id: 'f1', kind: 'format_shift', params: { resource_ref: IG, format: 'ig_carousel', weight_delta: 0.2 } });
  x.add({ id: 'a1', kind: 'advice', binding: 'advice' });
  x.add({ id: 't1', kind: 'pause_resource' });
  x.add({ id: 'tk', kind: 'task' });
  x.add({ id: 'q1', kind: 'frequency', params: { change_pct: 20 } });
  const done = await x.exec.executeAccepted(ORCH);
  const f1 = x.rows.get('f1');
  assert.equal(f1.status, 'applied');
  assert.deepEqual([f1.change.before, f1.change.after, f1.change.version, f1.change.noop], [0.3, 0.5, 2, false]);
  assert.equal(s.versions[1].directiveId, 'f1');
  assert.deepEqual(x.rows.get('a1').verification, { kind: 'self_reported' });
  assert.equal(x.rows.get('t1').verification.kind, 'unverified');
  assert.deepEqual([x.rows.get('tk').status, x.rows.get('tk').change], ['accepted', null], 'a task waits for report_directive_done');
  assert.equal(await x.exec.execute(x.rows.get('tk'), ORCH), x.rows.get('tk'), 'execute() leaves a task as it is');
  assert.equal(x.rows.get('q1').status, 'accepted', 'a kind that should have an executor but has none is not faked');
  assert.equal(x.rows.get('q1').execAttempts, 1);
  assert.deepEqual(done.map((r) => r.id).sort(), ['a1', 'f1', 'q1', 't1']);

  // verify(): pending until a plan exists, then a verdict.
  assert.equal(await x.exec.verifyApplied(), 0);
  s.plans.push({ planDate: '2026-10-21', createdAt: new Date('2026-10-20T20:00:00Z'), slots: [{ ref: IG, format: 'ig_carousel', series: null, status: 'planned' }] });
  assert.equal(await x.exec.verifyApplied(), 1);
  assert.equal(f1.verification.adherence, 'followed');
  assert.ok(f1.verifiedAt);
});

test('execution: a plan that cannot apply fails after 3 attempts with one Inbox entry (action for a directive, info for advice)', async () => {
  const s = store();
  const x = execSetup({ executors: [formatShiftExecutor(s.deps)] });
  x.add({ id: 'bad', kind: 'format_shift', params: { format: 'ig_reel', resource_ref: IG, weight_delta: 0.2 } });
  x.add({ id: 'adv', kind: 'format_shift', binding: 'advice', params: { format: 'nope', weight_delta: 0.2 } });
  for (let i = 0; i < MAX_EXEC_ATTEMPTS; i++) await x.exec.retryPending();
  assert.equal(x.rows.get('bad').status, 'failed');
  assert.equal(x.rows.get('bad').execAttempts, 3);
  assert.match(x.rows.get('bad').execError, /not_executable/);
  assert.deepEqual(x.inbox.map((i) => [i.kind, i.severity, i.refId]).sort(), [['directive_failed', 'action', 'bad'], ['directive_failed', 'info', 'adv']]);
  await x.exec.retryPending();
  assert.equal(x.inbox.length, 2, 'failed rows are not retried');
});

test('execution: a stored change is reused on retry — re-applying after a restart is a no-op', async () => {
  const s = store();
  const ex = formatShiftExecutor(s.deps);
  const change = ex.plan(dir('format_shift', { format: 'photo', weight_delta: 0.2 }), ctx()) as Change;
  await ex.apply(change, dir('format_shift', {}, { id: 'r1' }));
  assert.equal(s.versions.length, 2);
  // The process died before the status update: the row is still accepted with its change stored.
  const x = execSetup({ executors: [ex], context: async () => { throw new Error('context must not be needed'); } });
  x.add({ id: 'r1', kind: 'format_shift', change });
  await x.exec.retryPending();
  assert.equal(x.rows.get('r1').status, 'applied');
  assert.equal(x.rows.get('r1').change.noop, true);
  assert.equal(s.versions.length, 2, 'no second version');
});

test('execution: an apply that throws (section gone) counts an attempt', async () => {
  const s = store();
  const ex = formatShiftExecutor(s.deps);
  const x = execSetup({ executors: [ex] });
  x.add({ id: 'g1', kind: 'format_shift', change: { kind: 'format_shift', target: 'playbook', op: 'format_weight', resource_ref: 'threads:1', format: 'th_text', before: 0, after: 0.2, structural: false, reasons: [] } });
  await x.exec.executeAccepted(ORCH);
  assert.equal(x.rows.get('g1').execAttempts, 1);
  assert.match(x.rows.get('g1').execError, /gone/);
});

// ── FR-004: dry-run at filing ───────────────────────────────────────────────

test('file_directive dry-run: not_executable is never filed; a structural diff turns advice into an error and a directive into an owner card', async () => {
  const s = store();
  const x = execSetup({ executors: [formatShiftExecutor(s.deps), frequencyExecutor(s.deps), pauseSeriesExecutor(s.deps)] });
  const inserted: any[] = [];
  const inbox: any[] = [];
  const deps = {
    repo: {
      openFor: async () => null, lastRejected: async () => null, countForRun: async () => 0, countOpenBinding: async () => 0, lastDeclinedAdvice: async () => null,
      insert: async (d: any) => { const r = { id: `d${inserted.length + 1}`, ...d }; inserted.push(r); return r; }, update: async () => null,
    } as any,
    agents: { getByHandle: async () => ORCH, findTop: async () => null } as any,
    digest: { build: async () => ({ resources: [] }) as any, render: () => '' }, inbox: { post: async (i: any) => { inbox.push(i); return 1; } },
    memory: { listActive: async () => [] as any }, actions: { propose: async () => ({}) as any }, channelKeyOf: async () => '@space', exec: x.exec,
  };
  const base = {
    to: '@kira', binding: 'advice' as const, body: 'Змістити ваги форматів', rationale: 'Каруселі мають на 40% більше переглядів за 28 днів',
    evidence: { views: 1400 }, expected: { metric: 'views_per_post' as const, direction: 'up' as const, min_change_pct: 10 }, review_in_days: 7,
  };
  const o = { from: null, runId: 'r', shadow: false };
  const bad: any = await fileDirective(deps, { ...base, kind: 'format_shift', params: { resource_ref: IG, format: 'ig_reel', weight_delta: 0.2 } }, o);
  assert.equal(bad.error, 'not_executable');
  const unknown: any = await fileDirective(deps, { ...base, kind: 'pause_series', params: { series: 'Нема такої' } }, o);
  assert.equal(unknown.error, 'not_executable');
  const added: any = await fileDirective(deps, { ...base, kind: 'format_shift', params: { format: 'poll', weight_delta: 0.2 } }, o);
  assert.equal(added.error, 'structural_must_be_directive', 'a format added is structural by the dry-run, not by params');
  const asDirective: any = await fileDirective(deps, { ...base, binding: 'directive', kind: 'format_shift', params: { format: 'poll', weight_delta: 0.2 } }, o);
  assert.equal(asDirective.directive.status, 'awaiting_owner');
  assert.equal(asDirective.directive.structural, true);
  assert.match(inbox[0].body, /Change: telegram:@space: weight of poll 0 → 0.2/);
  const ok: any = await fileDirective(deps, { ...base, kind: 'format_shift', params: { resource_ref: IG, format: 'ig_carousel', weight_delta: 0.2 } }, o);
  assert.equal(ok.directive.status, 'new');
  assert.equal(ok.directive.outcomeDetail.dry_run.structural, false);
  assert.equal(s.versions.length, 1, 'a dry-run writes nothing');
});
