// Spec 071 FR-005 / A3: a series on a dataset that goes in order — the executor's note names the next row, and publishGuard
// refuses another row of that dataset (not_next_in_order). Series slots only; other datasets and free posts are not this guard's concern.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScheduleService } from './schedule.service';
import { nextRowLine } from './series-guard';

const NEXT = 'data://pdr_questions/5';

function service(o: { source?: any; sourceMode?: 'suggested' | 'required'; next?: string | null; noDep?: boolean; nextThrows?: boolean } = {}) {
  const asked: Array<[string, string, string | null]> = [];
  const series = {
    name: 'Білет дня', brief: 'Питання з відповіддю', format: 'quiz', cadence: 'daily 10:00', resource_ref: 'telegram:@pdr', active: true,
    source: o.source ?? { kind: 'library', table: 'pdr_questions', category: 'Знаки' }, source_mode: o.sourceMode ?? 'suggested',
  };
  const svc = new ScheduleService({
    pool: {
      query: async (sql: string, params: any[] = []) => {
        if (/FROM data_items d JOIN data_schemas s/.test(sql)) {
          const m = /^library:\/\/pdr_legacy\/(\d+)$/.exec(String(params[0]));
          return { rows: m ? [{ key: 'pdr_questions', id: '5', legacy_ref: params[0] }] : [] };
        }
        return { rows: [] };
      },
    } as any,
    rules: { get: async () => null, activeFor: async () => [] } as any,
    network: { activePlaybook: async () => ({ body: { series: [series] } }) } as any,
    agents: { findTop: async () => ({ id: 'o1', handle: 'pdr' }) } as any,
    card: async () => null, plans: {} as any, inbox: { post: async () => {} } as any,
    ...(o.noDep ? {} : {
      nextRow: async (res: string, ds: string, cat: string | null) => {
        asked.push([res, ds, cat]);
        if (o.nextThrows) throw new Error('db down');
        return o.next === undefined ? NEXT : o.next;
      },
    }),
  } as any);
  return { svc, asked };
}
const slot: any = { id: 's1', channelKey: '@pdr', resourceRef: 'telegram:@pdr', seriesName: 'Білет дня', scheduledAt: new Date(), format: 'quiz' };
const guard = (svc: ScheduleService, libraryRef: string | null, s = slot) =>
  svc.publishGuard(s, { libraryRef, sourceUrl: null }, { live: false, now: new Date(), feeds: [] });

test('executorContext: the series note names the next row of an in-order dataset, within the series category', async () => {
  const { svc, asked } = service();
  const r = await svc.executorContext(slot);
  assert.ok(r.note!.includes(nextRowLine(NEXT)));
  assert.match(r.note!, /наступний по черзі рядок data:\/\/pdr_questions\/5; бери саме його/);
  assert.match(r.note!, /не бери інший, навіть якщо в «Підказках джерел» названо інший data:\/\//, 'overrides the planner\'s hint');
  assert.deepEqual(asked, [['telegram:@pdr', 'pdr_questions', 'Знаки']]);
});

test('executorContext: no line when nothing is in order (null), the dep is absent or fails, or the source is not a library', async () => {
  for (const o of [{ next: null }, { noDep: true }, { nextThrows: true }] as const) {
    const { svc } = service(o);
    const r = await svc.executorContext(slot);
    assert.doesNotMatch(r.note!, /наступний по черзі/, JSON.stringify(o));
    assert.match(r.note!, /Це випуск серії «Білет дня»/);
  }
  const feed = service({ source: { kind: 'feed', ref: 'https://f.example/rss' } });
  assert.doesNotMatch((await feed.svc.executorContext(slot)).note!, /наступний по черзі/);
  assert.deepEqual(feed.asked, [], 'a feed series never asks for a row');
});

test('publishGuard: a series post must be the next row — another row of the series\' dataset is not_next_in_order', async () => {
  const { svc, asked } = service();
  const bad: any = await guard(svc, 'data://pdr_questions/6');
  assert.equal(bad.error, 'not_next_in_order');
  assert.match(bad.details, /серія бере рядки по черзі; наступний — data:\/\/pdr_questions\/5/);
  assert.deepEqual(asked[0], ['telegram:@pdr', 'pdr_questions', 'Знаки']);
  assert.equal(await guard(svc, NEXT), null);
});

test('publishGuard A3: a legacy library:// alias of the next row is canonicalised before the comparison', async () => {
  const { svc } = service();
  assert.equal(await guard(svc, 'library://pdr_legacy/5'), null, 'the alias resolves to data://pdr_questions/5');
  // A series that names the legacy table: the alias is compared with the canonical next row and matches.
  const legacy = service({ source: { kind: 'library', table: 'pdr_legacy' } });
  assert.equal(await guard(legacy.svc, 'library://pdr_legacy/5'), null);
  assert.deepEqual(legacy.asked[0], ['telegram:@pdr', 'pdr_legacy', null]);
});

test('publishGuard A3: only a post that names a row of THE series dataset is checked; free posts, other datasets, no row, no next → not this guard\'s concern', async () => {
  const { svc, asked } = service();
  assert.equal(await guard(svc, null), null, 'no library_ref');
  assert.equal(await guard(svc, 'data://quotes/9'), null, 'another dataset (seriesSourceMismatch handles required sources)');
  assert.deepEqual(asked, []);
  const noNext = service({ next: null });
  assert.equal(await guard(noNext.svc, 'data://pdr_questions/6'), null, 'nothing in order to compare with');
  const noDep = service({ noDep: true });
  assert.equal(await guard(noDep.svc, 'data://pdr_questions/6'), null);
  const boom = service({ nextThrows: true });
  assert.equal(await guard(boom.svc, 'data://pdr_questions/6'), null, 'a read error never blocks a post');
  // A slot with no series (a free post) is not ordered either.
  const free: any = { ...slot, seriesName: null };
  assert.equal(await guard(svc, 'data://pdr_questions/6', free), null);
  assert.deepEqual(asked, []);
});

test('publishGuard: a required library source keeps series_source_mismatch ahead of the order check', async () => {
  const { svc } = service({ sourceMode: 'required' });
  const wrong: any = await guard(svc, 'data://quotes/9');
  assert.equal(wrong.error, 'series_source_mismatch');
  const order: any = await guard(svc, 'data://pdr_questions/6');
  assert.equal(order.error, 'not_next_in_order');
});
