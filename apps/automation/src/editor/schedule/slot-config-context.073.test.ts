/**
 * Spec 073 FR-009 (T12; A3, A4, A12, A16, I1): `ScheduleService.slotConfigContext` is the one loader of the config check's context.
 * It reads and never writes: no inbox post on an empty required source, and no round is started (`roll: false` reaches both ports).
 * It returns null when there is nothing to check; `executorContext`, the run itself, still rolls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScheduleService } from './schedule.service';
import { checkSlotConfig } from '../readiness/slot-config';
import { makeCard } from '../post/testing/fixtures';

const REF = 'telegram:@pdr';
const NEXT = 'data://pdr_questions/5';
const card = makeCard({ channelKey: '@pdr' });

interface Calls { inbox: unknown[]; unposted: Array<[string, string, unknown]>; nextRow: Array<[string, string, string | null, unknown]> }

function service(o: {
  series?: any[]; noOrch?: boolean; noPlaybook?: boolean; left?: number | null; next?: string | null; mode?: 'suggested' | 'required'; source?: any; catalogThrows?: boolean;
} = {}) {
  const calls: Calls = { inbox: [], unposted: [], nextRow: [] };
  const base = {
    name: 'Білет дня', brief: 'Питання з відповіддю', format: 'quiz', cadence: 'daily 10:00', resource_ref: REF, active: true,
    source: o.source ?? { kind: 'library', table: 'pdr_questions' }, source_mode: o.mode ?? 'required',
  };
  const series = o.series ?? [base];
  const svc = new ScheduleService({
    pool: { query: async () => ({ rows: [] }) } as any,
    rules: { get: async () => null, activeFor: async () => [] } as any,
    network: { activePlaybook: async () => (o.noPlaybook ? null : { body: { series } }) } as any,
    agents: { findTop: async () => (o.noOrch ? null : { id: 'o1', handle: 'pdr' }) } as any,
    card: async () => null, plans: {} as any, inbox: { post: async (...a: unknown[]) => { calls.inbox.push(a); } } as any,
    sourceCatalog: async () => {
      if (o.catalogThrows) throw new Error('db down');
      return { tables: ['pdr_questions'], feeds: [], entities: { pdr_questions: 'quiz_question' } };
    },
    unposted: async (r: string, d: string, opt?: unknown) => { calls.unposted.push([r, d, opt]); return o.left === undefined ? 12 : o.left; },
    nextRow: async (r: string, d: string, c: string | null, opt?: unknown) => { calls.nextRow.push([r, d, c, opt]); return o.next === undefined ? NEXT : o.next; },
  } as any);
  return { svc, calls };
}
const slot = (over: Record<string, unknown> = {}): any => ({
  id: 's1', channelKey: '@pdr', resourceRef: REF, seriesName: 'Білет дня', sourceHints: [], format: 'quiz', scheduledAt: new Date(), ...over,
});

test('A3 an empty required source: material "empty", zero inbox calls, no next row asked; the read-only ports get roll:false', async () => {
  const { svc, calls } = service({ left: 0 });
  const ctx = await svc.slotConfigContext(card, slot());
  assert.equal(ctx?.material, 'empty');
  assert.equal(ctx?.nextRow, null);
  assert.deepEqual(calls.inbox, [], 'executorContext would post series_source_empty; this does not');
  assert.deepEqual(calls.unposted, [[REF, 'pdr_questions', { roll: false }]]);
  assert.deepEqual(calls.nextRow, [], 'nothing left, no row to ask for');
  // The check turns it into the material code.
  assert.deepEqual(checkSlotConfig({ channelKey: '@pdr', resourceRef: REF, format: 'quiz', seriesName: 'Білет дня', sourceHints: [] }, ctx!).map((p) => p.code), ['preflight_no_material']);
});

test('I1 the next row is asked with roll:false too; material "ok" when rows are left, null when unknown', async () => {
  const ok = service({ left: 3 });
  const ctx = await ok.svc.slotConfigContext(card, slot());
  assert.equal(ctx?.material, 'ok');
  assert.equal(ctx?.nextRow, NEXT);
  assert.deepEqual(ok.calls.nextRow, [[REF, 'pdr_questions', null, { roll: false }]]);
  assert.equal((await service({ left: null }).svc.slotConfigContext(card, slot()))?.material, null);
  // A suggested source has no «empty»: the count is not read at all.
  const suggested = service({ mode: 'suggested', left: 0 });
  assert.equal((await suggested.svc.slotConfigContext(card, slot()))?.material, null);
  assert.deepEqual(suggested.calls.unposted, []);
});

test('A16 null when the slot names no series, the channel has no orchestrator, or it has no active playbook', async () => {
  assert.equal(await service().svc.slotConfigContext(card, slot({ seriesName: null })), null);
  assert.equal(await service({ noOrch: true }).svc.slotConfigContext(card, slot()), null);
  assert.equal(await service({ noPlaybook: true }).svc.slotConfigContext(card, slot()), null);
});

test('A16 the series name may come from the `series:` hint (slotSeriesOf), as in the poll cap', async () => {
  const ctx = await service().svc.slotConfigContext(card, slot({ seriesName: null, sourceHints: ['series:Білет дня'] }));
  assert.ok(ctx);
  assert.equal(ctx!.series?.[0].name, 'Білет дня');
});

test('A4 series carries the playbook\'s full list, inactive ones included; a switched-off or missing series reads no material', async () => {
  const off = { name: 'Білет дня', brief: 'x'.repeat(12), format: 'quiz', cadence: 'daily 10:00', resource_ref: REF, active: false, source: { kind: 'library', table: 'pdr_questions' }, source_mode: 'required' };
  const other = { ...off, name: 'Інша', active: true };
  const { svc, calls } = service({ series: [off, other] });
  const ctx = await svc.slotConfigContext(card, slot());
  assert.deepEqual(ctx?.series?.map((s) => [s.name, s.active]), [['Білет дня', false], ['Інша', true]]);
  assert.equal(ctx?.material, null);
  assert.deepEqual(calls.unposted, [], 'a switched-off series costs no query');
  const gone = await service({ series: [other] }).svc.slotConfigContext(card, slot());
  assert.deepEqual(checkSlotConfig({ channelKey: '@pdr', resourceRef: REF, format: 'quiz', seriesName: 'Білет дня', sourceHints: [] }, gone!).map((p) => p.code), ['config_series_gone']);
});

test('A12 the tools are what the caller passes (the runner), null for everyone else; the catalog is the service\'s, null when it fails', async () => {
  const tools = new Set(['query_data']);
  const { svc } = service();
  assert.equal((await svc.slotConfigContext(card, slot(), { tools }))?.tools, tools);
  assert.equal((await svc.slotConfigContext(card, slot()))?.tools, null);
  assert.deepEqual((await svc.slotConfigContext(card, slot()))?.catalog?.tables, ['pdr_questions']);
  assert.equal((await service({ catalogThrows: true }).svc.slotConfigContext(card, slot()))?.catalog, null);
});

test('A4 seriesForSlot returns `active`; executorContext (a run) still posts the inbox note and still rolls', async () => {
  const { svc, calls } = service({ left: 0 });
  assert.equal((await svc.seriesForSlot(slot()))?.active, true);
  const r = await svc.executorContext(slot());
  assert.match(r.skip ?? '', /has nothing left on telegram:@pdr/);
  assert.equal(calls.inbox.length, 1, 'series_source_empty is the run\'s note');
  assert.deepEqual(calls.unposted.at(-1), [REF, 'pdr_questions', { roll: true }], 'a run may start the next round');
  const live = service({ left: 4 });
  const ok = await live.svc.executorContext(slot());
  assert.equal(ok.nextRow, NEXT);
  assert.deepEqual(live.calls.nextRow, [[REF, 'pdr_questions', null, { roll: true }]]);
});
