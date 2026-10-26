// Spec 071: skip_slot `ref` puts a library row aside for the round; sourceGuard (A7) does not stop a cycle-dataset row because
// the URL it cites was used in an earlier round, and says «пропущене в цьому колі» for a passed row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoleTools, sourceGuard, type RoleToolDeps } from './role-tools';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import { sourceUsedDetails } from '../../data/ledger-anchor';
import { PreviewSink } from '../roles/preview-run';

const URL1 = 'https://zakon.rada.gov.ua/laws/show/1306-2001-%D0%BF';
const ROW = 'data://pdr_questions/42';

function toolsWith(over: { passRow?: RoleToolDeps['passRow']; slot?: any; pool?: any } = {}) {
  const updates: any[] = [];
  const plans: any = {
    getSlot: async (id: string) => over.slot ?? { id, channelKey: '@chan', resourceRef: 'telegram:@chan', status: 'running' },
    updateSlot: async (id: string, p: any) => { updates.push([id, p]); },
  };
  const d = { pool: over.pool ?? { query: async () => ({ rows: [] }) }, plans, ...(over.passRow ? { passRow: over.passRow } : {}), now: () => new Date('2026-10-26T09:00:00Z') } as unknown as RoleToolDeps;
  return { tools: Object.fromEntries(buildRoleTools(d).map((t) => [t.name, t])), updates };
}
const ctx = (extras: any = {}) => ({ runId: 'r', role: 'executor' as const, channelKey: '@chan', slotId: 'slot-1', extras: { card: makeCard({ mode: 'shadow' }), ...extras } });

test('skip_slot with ref: the slot is skipped and the row is put aside on the slot\'s resource (passed_ref in the answer)', async () => {
  const seen: any[] = [];
  const { tools, updates } = toolsWith({ passRow: async (slot, ref, reason) => { seen.push({ slot, ref, reason }); return true; } });
  const r: any = await tools.skip_slot.execute({ reason: 'у рядку немає тексту питання', ref: ROW }, ctx());
  assert.equal(updates[0][1].status, 'skipped');
  assert.equal(r.passed_ref, ROW);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ref, ROW);
  assert.equal(seen[0].slot.resourceRef, 'telegram:@chan');
  assert.equal(seen[0].reason, 'у рядку немає тексту питання');
});

test('skip_slot ref: the input takes a content ref only; no ref, a dry run, a missing dep and a failing passRow change nothing', async () => {
  const h = toolsWith({ passRow: async () => true });
  const schema = (h.tools.skip_slot as any).input;
  assert.equal(schema.safeParse({ reason: 'немає даних у рядку', ref: ROW }).success, true);
  assert.equal(schema.safeParse({ reason: 'немає даних у рядку', ref: 'library://recipes/12' }).success, true);
  assert.equal(schema.safeParse({ reason: 'немає даних у рядку', ref: 'https://x.example/a' }).success, false);
  assert.equal(schema.safeParse({ reason: 'немає даних у рядку' }).success, true);

  const calls: string[] = [];
  const none = toolsWith({ passRow: async (_s, ref) => { calls.push(ref); return true; } });
  assert.equal(((await none.tools.skip_slot.execute({ reason: 'нічого свіжого сьогодні' }, ctx())) as any).passed_ref, undefined);
  assert.equal(calls.length, 0, 'no ref, no pass');

  // The owner's dry-run Preview (extras.dryRun sink) never records anything.
  const dry = toolsWith({ passRow: async (_s, ref) => { calls.push(ref); return true; }, slot: { id: 'slot-1', channelKey: '@chan', status: 'planned' } });
  await dry.tools.skip_slot.execute({ reason: 'у рядку немає тексту питання', ref: ROW }, ctx({ dryRun: new PreviewSink() }));
  assert.equal(calls.length, 0);

  const noDep = toolsWith();
  const r: any = await noDep.tools.skip_slot.execute({ reason: 'у рядку немає тексту питання', ref: ROW }, ctx());
  assert.deepEqual([r.ok, r.skipped, r.passed_ref], [true, true, undefined]);

  const boom = toolsWith({ passRow: async () => { throw new Error('db down'); } });
  const b: any = await boom.tools.skip_slot.execute({ reason: 'у рядку немає тексту питання', ref: ROW }, ctx());
  assert.deepEqual([b.ok, b.skipped, b.passed_ref], [true, true, undefined]);
  assert.equal(boom.updates[0][1].status, 'skipped');
});

/** A plans stub where the library row is open but the cited URL was used (in an earlier round). */
function plans(o: { rowUsed?: any; urlUsed?: boolean } = {}) {
  const asked: string[] = [];
  const p: any = {
    sourceAlreadyPosted: async (_k: string, ref: string) => { asked.push(ref); return ref === ROW ? !!o.rowUsed : !!o.urlUsed; },
    sourceVerdict: async (_k: string, ref: string) => (asked.push(`verdict:${ref}`), ref === URL1 ? { used: !!o.urlUsed, status: 'published', resourceRef: 'telegram:@chan', ref, at: new Date('2026-06-01T00:00:00Z') } : (o.rowUsed ?? { used: false })),
  };
  return { p, asked };
}
const spec = (over: any = {}) => makeSpec({ origin: 'library', library_ref: ROW, source: { url: URL1, name: 'Закон' }, ...over });
/** `kind` is what data_schemas says about the dataset behind the library_ref. */
const poolOf = (kind: string | null) => ({
  query: async (sql: string) => {
    if (/FROM data_items d JOIN data_schemas s/.test(sql)) return { rows: kind ? [{ key: 'pdr_questions', id: '42', legacy_ref: null }] : [] };
    if (/SELECT reuse_policy->>'kind'/.test(sql)) return { rows: [{ kind }] };
    return { rows: [] };
  },
}) as any;

test('A7: a row of a cycle dataset that is open in the round is not refused because the URL it cites was used earlier', async () => {
  const cycle = plans({ urlUsed: true });
  assert.equal(await sourceGuard({ plans: cycle.p, pool: poolOf('cycle') }, '@chan', spec()), null);
  assert.deepEqual(cycle.asked, [ROW], 'the URL is not asked at all');

  // The same post under a never dataset is refused, as before.
  const never = plans({ urlUsed: true });
  const r: any = await sourceGuard({ plans: never.p, pool: poolOf('never') }, '@chan', spec());
  assert.equal(r.error, 'source_already_posted');
  assert.deepEqual(never.asked, [ROW, `verdict:${URL1}`]);
  // No pool (a caller that cannot tell) keeps today's check; so does a post without a library_ref.
  assert.equal(((await sourceGuard({ plans: plans({ urlUsed: true }).p }, '@chan', spec())) as any).error, 'source_already_posted');
  assert.equal(((await sourceGuard({ plans: plans({ urlUsed: true }).p, pool: poolOf('cycle') }, '@chan', spec({ library_ref: undefined, origin: 'external' }))) as any).error, 'source_already_posted');
});

test('A7: the row itself is still checked first — a cycle row done in this round is refused', async () => {
  const done = plans({ rowUsed: { used: true, status: 'published', resourceRef: 'telegram:@chan', ref: ROW, at: new Date('2026-10-20T00:00:00Z') }, urlUsed: true });
  const r: any = await sourceGuard({ plans: done.p, pool: poolOf('cycle') }, '@chan', spec());
  assert.equal(r.error, 'library_item_already_posted');
  assert.equal(r.details, undefined, 'published: the answer is as before');
});

test('a row put aside for the round (passed) is refused with the round text', async () => {
  const passed = plans({ rowUsed: { used: true, status: 'passed', resourceRef: 'telegram:@chan', ref: ROW, at: new Date() } });
  const r: any = await sourceGuard({ plans: passed.p, pool: poolOf('cycle') }, '@chan', spec());
  assert.equal(r.error, 'library_item_already_posted');
  assert.match(r.details, /data:\/\/pdr_questions\/42: пропущене в цьому колі/);
  assert.match(r.details, /повернеться в наступному колі/);
  assert.equal(sourceUsedDetails(URL1, { status: 'passed' }, true), `${URL1}: пропущене в цьому колі — з нього не вийшов пост; воно повернеться в наступному колі, візьміть інший рядок`);
  assert.match(sourceUsedDetails(URL1, { status: 'published' }, false), /уже використано/, 'other statuses keep their text');
});
