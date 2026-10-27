// Spec 068 FR-006 / FR-007: the pre-flight judges library slots (rows and datasets), leaves the series / directive labels out of
// the URL test, treats unknown hint kinds as usable, and runs the same checks on a planned slot without a swap. Fakes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PREFLIGHT_CODES, SlotPreflight, usedWhy, type PreflightDeps, type PreflightMaterial } from './slot-preflight';
import { PLAN_TIME_WAY_OUT, planTimePreflightErrors } from './plan-time';
import { ideaOutcomeOf } from '../network/idea-outcome';
import { preflightCauseOf, skipGroupOf } from '../silent/skip-reasons';
import { classifyClose } from '../series-pause/skip-cause';
import { makeCard } from '../post/testing/fixtures';

const NOW = new Date('2026-10-27T09:00:00Z');
const REF = 'telegram:@chan';

interface Rows { [ref: string]: { active?: boolean; postable?: boolean; missing?: string[] } | undefined }

function build(o: { rows?: Rows; unposted?: Record<string, number | null>; used?: Set<string>; blocked?: Set<string>; material?: boolean; env?: Record<string, string>; ledgerThrows?: boolean; idea?: any; accepted?: any[] } = {}) {
  const calls = { ledger: [] as string[], row: [] as string[], unposted: [] as string[], retopic: 0, claim: 0, release: 0, idea: 0 };
  const material: PreflightMaterial = {
    row: async (ref) => {
      calls.row.push(ref);
      const r = o.rows?.[ref];
      return r ? { active: r.active ?? true, postable: r.postable ?? true, missing: r.missing ?? [] } : null;
    },
    unposted: async (res, dataset) => { calls.unposted.push(`${res}|${dataset}`); return o.unposted && dataset in o.unposted ? o.unposted[dataset] : null; },
  };
  const d: PreflightDeps = {
    ledger: {
      check: async (_r: string, ref: string) => {
        calls.ledger.push(ref);
        if (o.ledgerThrows) throw new Error('db down');
        return o.used?.has(ref) ? { used: true, status: 'published', resourceRef: REF, ref, at: new Date('2026-10-20T10:00:00Z'), slotId: 'old-slot' } : { used: false };
      },
    } as any,
    ...(o.material === false ? {} : { material }),
    hosts: { blocked: async (host: string) => (o.blocked?.has(host) ? { host, reason: 'refused', statusCode: 403, until: new Date(NOW.getTime() + 86_400_000) } : null) } as any,
    ideas: {
      idea: async () => { calls.idea++; return o.idea ?? null; },
      accepted: async () => o.accepted ?? [],
      claim: async () => { calls.claim++; return true; },
      release: async () => { calls.release++; },
    },
    retopic: async () => { calls.retopic++; },
    env: (k) => o.env?.[k],
    freshnessHours: async () => 36,
    now: () => NOW,
  };
  return { pf: new SlotPreflight(d), calls };
}
const slot = (hints: string[], over: any = {}): any => ({
  id: 's1', channelKey: '@chan', scheduledAt: NOW, kind: 'content', format: 'text', topic: 'Тема', angle: null, sourceHints: hints,
  ideaId: null, seriesName: 'Prompt', isExperiment: false, status: 'running', attempts: 0, ...over,
});
const card = makeCard();
const ROW = 'data://prompts/7';

test('the new code is a pre-flight code and a classified one (nothing fresh, a missing material, the idea closed)', () => {
  assert.ok((PREFLIGHT_CODES as readonly string[]).includes('preflight_no_material'));
  assert.equal(skipGroupOf('preflight_no_material: рядок data://prompts/7 без prompt_text'), 'nothing_fresh');
  assert.equal(preflightCauseOf('preflight_no_material: x'), 'no_material');
  assert.deepEqual(classifyClose({ status: 'skipped', error: 'preflight_no_material: x' }), { k: 'cause', cause: 'no_material' });
  assert.equal(ideaOutcomeOf('skipped', 'preflight_no_material: x').status, 'rejected');
});

test('data:// row: missing, inactive and without the needed field are no material; a spent one is source_used; a good one passes', async () => {
  const missing = await build({}).pf.run(slot([ROW]), card);
  assert.deepEqual([missing.ok, !missing.ok && missing.code, !missing.ok && missing.reason], [false, 'preflight_no_material', `рядок ${ROW} не знайдено`]);

  const inactive = await build({ rows: { [ROW]: { active: false } } }).pf.run(slot([ROW]), card);
  assert.equal(!inactive.ok && inactive.code, 'preflight_no_material');
  assert.match(!inactive.ok ? inactive.reason : '', /не активний/);

  const noText = await build({ rows: { [ROW]: { postable: false, missing: ['prompt_text'] } } }).pf.run(slot([ROW]), card);
  assert.equal(!noText.ok && noText.code, 'preflight_no_material');
  assert.equal(!noText.ok && noText.reason, `рядок ${ROW} без prompt_text`);
  const noTwo = await build({ rows: { [ROW]: { postable: false, missing: ['page_url', 'prompt_text or media_url'] } } }).pf.run(slot([ROW]), card);
  assert.match(!noTwo.ok ? noTwo.reason : '', /без page_url, prompt_text or media_url/);

  const spent = await build({ rows: { [ROW]: {} }, used: new Set([ROW]) }).pf.run(slot([ROW]), card);
  assert.equal(!spent.ok && spent.code, 'preflight_source_used');
  assert.match(!spent.ok ? spent.reason : '', /рядок data:\/\/prompts\/7 уже використано 2026-10-20 у слоті old-slot/);

  const good = build({ rows: { [ROW]: {} } });
  assert.equal((await good.pf.run(slot([ROW]), card)).ok, true);
  assert.deepEqual(good.calls.ledger, [ROW], 'the ledger is asked about the row on this resource, after the row passed');
});

test('library:// alias is judged like data:// (the data store resolves it)', async () => {
  const L = 'library://prompts/42';
  const r = await build({ rows: { [L]: { postable: false, missing: ['prompt_text'] } } }).pf.run(slot([L]), card);
  assert.equal(!r.ok && r.code, 'preflight_no_material');
});

test('library:<table>: an empty dataset on the resource is no material; rows left, an unknown dataset or a category pass', async () => {
  const empty = build({ unposted: { recipes: 0 } });
  const r = await empty.pf.run(slot(['library:recipes']), card);
  assert.deepEqual([!r.ok && r.code, !r.ok && r.reason], ['preflight_no_material', `у датасеті recipes немає непублікованих рядків для ${REF}`]);
  assert.deepEqual(empty.calls.unposted, [`${REF}|recipes`]);

  assert.equal((await build({ unposted: { recipes: 12 } }).pf.run(slot(['library:recipes']), card)).ok, true);
  assert.equal((await build({ unposted: { recipes: null } }).pf.run(slot(['library:recipes']), card)).ok, true, 'unknown = usable');
  const cat = build({ unposted: { recipes: 0 } });
  assert.equal((await cat.pf.run(slot(['library:recipes/desserts']), card)).ok, false, 'the category is ignored: the table decides');
  assert.deepEqual(cat.calls.unposted, [`${REF}|recipes`]);
});

test('the slot fails only when every material hint fails; the most informative reason is reported', async () => {
  // Review 4: Prompt slots carried series + library + one row. A bad row with rows left in the dataset can still run.
  const rowBadDatasetFine = build({ rows: { [ROW]: { postable: false, missing: ['prompt_text'] } }, unposted: { prompts: 40 } });
  assert.equal((await rowBadDatasetFine.pf.run(slot(['series:Prompt', 'library:prompts', ROW]), card)).ok, true);

  const allBad = build({ rows: { [ROW]: { postable: false, missing: ['prompt_text'] } }, unposted: { prompts: 0 } });
  const r = await allBad.pf.run(slot(['series:Prompt', 'library:prompts', ROW]), card);
  assert.equal(!r.ok && r.code, 'preflight_no_material');

  // A spent URL and a row without text: nothing to post comes first.
  const mixed = build({ rows: { [ROW]: { postable: false, missing: ['prompt_text'] } }, used: new Set(['https://a.example/x']) });
  const m = await mixed.pf.run(slot([ROW, 'https://a.example/x']), card);
  assert.equal(!m.ok && m.code, 'preflight_no_material');
  const usedFirst = build({ rows: { [ROW]: {} }, used: new Set([ROW, 'https://a.example/x']), blocked: new Set(['a.example']) });
  assert.equal(((await usedFirst.pf.run(slot([ROW, 'https://a.example/x']), card)) as any).code, 'preflight_source_used');
});

test('series: and directive: labels are not material: the URL hints of a series slot are judged', async () => {
  const spent = await build({ used: new Set(['https://a.example/x']) }).pf.run(slot(['series:Топ тижня', 'directive:d1', 'https://a.example/x']), card);
  assert.equal(!spent.ok && spent.code, 'preflight_source_used', 'before 068 the series label disabled the check');
  const labels = build({});
  assert.equal((await labels.pf.run(slot(['series:Топ тижня', 'directive:d1']), card)).ok, true, 'nothing to judge');
  assert.deepEqual(labels.calls.ledger, []);
});

test('other kinds (feed:, api:, network_highlights:) count as usable; so does a failing hint beside one', async () => {
  for (const k of ['feed:rss1', 'api:nasa_apod', 'network_highlights:space']) {
    const b = build({ used: new Set(['https://a.example/x']) });
    assert.equal((await b.pf.run(slot([k, 'https://a.example/x']), card)).ok, true, k);
    assert.equal((await b.pf.run(slot([k]), card)).ok, true, k);
  }
});

test('without the data store wired a row / dataset hint cannot be judged and passes; a failing check never stops the slot', async () => {
  assert.equal((await build({ material: false }).pf.run(slot([ROW, 'library:prompts']), card)).ok, true);
  assert.equal((await build({ rows: { [ROW]: {} }, ledgerThrows: true }).pf.run(slot([ROW]), card)).ok, true);
});

test('a library slot is not swapped for another idea: it is skipped with the code', async () => {
  const b = build({});
  const r = await b.pf.run(slot([ROW], { ideaId: 'i1', seriesName: null }), card);
  assert.equal(r.ok, false, 'no idea in the pool to swap to, and the idea behind it is gone');
  assert.equal(b.calls.retopic + b.calls.claim, 0);
});

// Review fix R6: a slot that carries a manager directive (an experiment quota) would lose `directive:<id>` and the angle in a swap.
test('a slot with a directive: hint is failed, not swapped, when its source is spent; the same slot without it is swapped', async () => {
  const idea = (id: string, sources: string[]) => ({
    id, agentId: 'o1', title: `Ідея ${id}`, angle: null, sources, variants: [{ resource_ref: REF, format: 'text' }], why: null, evidence: null,
    origin: 'orchestrator', originRef: null, expiresAt: new Date(NOW.getTime() + 86_400_000), status: 'accepted', revisions: 0, review: null, createdAt: NOW, updatedAt: NOW,
  });
  const spent = 'https://a.example/spent';
  const from = idea('i1', [spent]);
  const fresh = idea('i2', ['https://a.example/fresh']);
  const over = { seriesName: null, ideaId: 'i1', isExperiment: true };

  const withDirective = build({ used: new Set([spent]), idea: from, accepted: [from, fresh] });
  const failed = await withDirective.pf.run(slot(['directive:d1', spent], over), card);
  assert.equal(failed.ok, false);
  assert.equal(!failed.ok && failed.code, 'preflight_source_used');
  assert.deepEqual([withDirective.calls.retopic, withDirective.calls.claim, withDirective.calls.release], [0, 0, 0], 'no swap: the idea stays, nothing is retopiced');

  // The control: without the directive hint the same slot is swapped for the fresh idea.
  const plain = build({ used: new Set([spent]), idea: from, accepted: [from, fresh] });
  const swapped = await plain.pf.run(slot([spent], over), card);
  assert.equal(swapped.ok, true);
  assert.equal(swapped.ok && swapped.swapped?.toIdeaId, 'i2');
  assert.equal(plain.calls.retopic, 1);
});

test('assessPlanned: the same checks on a planned slot, no swap, nothing written; fixed posts, live slots and a broken check are not judged', async () => {
  const b = build({ rows: { [ROW]: { postable: false, missing: ['prompt_text'] } } });
  const p = await b.pf.assessPlanned(slot([ROW], { id: undefined }), card);
  assert.equal(p?.code, 'preflight_no_material');
  assert.equal(b.calls.retopic + b.calls.claim + b.calls.release, 0);

  assert.equal(await b.pf.assessPlanned(slot([ROW], { kind: 'reserved' }), card), null);
  assert.equal(await b.pf.assessPlanned(slot([ROW], { promo: true }), card), null);
  assert.equal(await b.pf.assessPlanned(slot([ROW], { treatment: 'duplicate' }), card), null);
  assert.equal(await b.pf.assessPlanned(slot([ROW], { treatment: 'adapt' }), card), null);
  assert.equal(await b.pf.assessPlanned(slot([ROW], { topicMode: 'live' }), card), null);
  assert.equal(await build({ rows: { [ROW]: {} }, ledgerThrows: true }).pf.assessPlanned(slot([ROW]), card), null, 'never throws');

  // The format check is part of it: a carousel without slide hosting is told to the planner too.
  const car = await build({}).pf.assessPlanned(slot([], { format: 'carousel' }), card);
  assert.equal(car?.code, 'preflight_format_unavailable');
  assert.equal(await build({ env: { SUPABASE_URL: 'u', SUPABASE_SERVICE_KEY: 'k', SUPABASE_CAROUSEL_BUCKET: 'b' } }).pf.assessPlanned(slot([], { format: 'carousel' }), card), null);
});

test('assessPlanned reads the idea for the staleness fallback, like the run-time check', async () => {
  const b = build({});
  await b.pf.assessPlanned(slot(['https://a.example/x'], { ideaId: 'i1' }), card);
  assert.equal(b.calls.idea, 1);
});

test('plan-time lines: slot label, the reason and the way out; a format problem asks for another format; no pre-flight, no lines', async () => {
  const b = build({ rows: { [ROW]: { postable: false, missing: ['prompt_text'] } } });
  const lines = await planTimePreflightErrors(b.pf, card, [
    { label: 'слот 1 (12:00)', slot: slot([ROW]) },
    { label: 'слот 2 (14:00)', slot: slot(['https://fine.example/x'], { seriesName: null }) },
    { label: 'слот 3 (16:00)', slot: slot([], { format: 'carousel' }) },
  ]);
  assert.equal(lines.length, 2, 'the fine slot gets no line');
  assert.equal(lines[0], `слот 1 (12:00): рядок ${ROW} без prompt_text — ${PLAN_TIME_WAY_OUT}`);
  assert.match(lines[1], /^слот 3 \(16:00\): формат «carousel» потребує хостингу слайдів.* — обери інший формат$/);
  assert.match(PLAN_TIME_WAY_OUT, /skipped_series з cause no_material \/ short_day/);
  assert.deepEqual(await planTimePreflightErrors(undefined, card, [{ label: 'x', slot: slot([ROW]) }]), []);
});

test('usedWhy says what the executor and the planner are told', () => {
  const at = new Date('2026-10-20T10:00:00Z');
  const hit = (status: any, slotId?: string) => ({ used: true as const, status, resourceRef: REF, ref: 'x', at, slotId });
  assert.equal(usedWhy(hit('published', 's9')), 'уже використано 2026-10-20 у слоті s9');
  assert.equal(usedWhy(hit('waiting')), 'уже чекає на публікацію');
  assert.equal(usedWhy(hit('error')), 'позначене як непридатне');
});
