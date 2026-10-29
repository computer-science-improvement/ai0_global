import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CardSource } from '../../card';
import type { SeriesPause } from '../../series-pause/series-pauses.repository';
import { makeFacts, mkDataset, mkPlaybook, mkSeries, NOW, promptSeries } from '../testing/facts-fixture';
import { pausesCheck } from './pauses';

/** Spec 072 FR-003.5, A12: series_paused, series_paused_by_owner and pause_cause_gone. */

const run = (init: Parameters<typeof makeFacts>[0]) => pausesCheck.run(makeFacts(init));
const PAUSED_AT = new Date(NOW.getTime() - 3 * 86_400_000);
const pause = (over: Partial<SeriesPause> = {}): SeriesPause => ({
  id: 'p1', channelKey: '@fx072', key: 'series:Prompt', label: 'Prompt', cause: 'no_material', reason: 'no rows', streak: 4,
  pausedAt: PAUSED_AT, resumedAt: null, resumedBy: null, ...over,
});
const resume = (id = 'p1') => ({ kind: 'series_resume', channel: '@fx072', pauseId: id });
const ds = (over: Record<string, unknown> = {}) => mkDataset({ key: 'prompts', unusedPostable: 0, rows: 40, ...over } as never);
const prompt = () => mkPlaybook([promptSeries()]);

// ── owner ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test('a pause by the owner is info and never has a fix', () => {
  const [x, ...rest] = run({ pauses: [pause({ cause: 'owner', reason: 'owner' })] });
  assert.equal(rest.length, 0);
  assert.equal(x.check, 'series_paused_by_owner');
  assert.equal(x.severity, 'info');
  assert.deepEqual(x.subject, { type: 'channel', id: 'p1', label: 'Prompt', agent: 'fx072', channel: '@fx072' });
  assert.equal(x.fix, undefined);
  assert.equal(x.link, '/app/agents/fx072?tab=overview');
  assert.match(x.detail, /paused by you since 2026-10-17/);
});

// ── no_material ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('a no_material pause whose dataset is still empty is info with a resume button', () => {
  const [x] = run({ pauses: [pause()], playbook: prompt(), datasets: [ds()] });
  assert.equal(x.check, 'series_paused');
  assert.equal(x.severity, 'info');
  assert.deepEqual(x.fix, resume());
  assert.equal((x.evidence as any).dataset, 'prompts');
  assert.match(x.detail, /after 4 skipped slots in a row: it had no material/);
});

test('when the dataset has postable unused rows again, the pause is pause_cause_gone (warn, resume)', () => {
  const [x] = run({ pauses: [pause()], playbook: prompt(), datasets: [ds({ unusedPostable: 12 })] });
  assert.equal(x.check, 'pause_cause_gone');
  assert.equal(x.severity, 'warn');
  assert.deepEqual(x.fix, resume());
  assert.equal((x.evidence as any).unused_postable, 12);
  assert.match(x.detail, /prompts has rows that can be posted again \(12\)/);
});

test('a cycle dataset counts its postable rows: rolling rounds are material, rows that cannot be posted are not', () => {
  const cycle = { reusePolicy: { kind: 'cycle', order: 'random' }, unusedPostable: 0 };
  assert.equal(run({ pauses: [pause()], playbook: prompt(), datasets: [ds({ ...cycle, rows: 10, notPostable: 0 })] })[0].check, 'pause_cause_gone');
  assert.equal(run({ pauses: [pause()], playbook: prompt(), datasets: [ds({ ...cycle, rows: 10, notPostable: 10 })] })[0].check, 'series_paused');
});

test('a pause that names no library series stays info: nothing to prove', () => {
  const lone = (key: string) => run({ pauses: [pause({ key })], playbook: prompt(), datasets: [ds({ unusedPostable: 99 })] });
  assert.equal(lone('rule:r1')[0].check, 'series_paused');
  assert.equal(lone('resource:telegram:@fx072')[0].check, 'series_paused');
  assert.equal(lone('series:Ghost')[0].check, 'series_paused');
  const feed = run({ pauses: [pause({ key: 'series:Feed' })], playbook: mkPlaybook([mkSeries({ name: 'Feed', source: { kind: 'feed', ref: 'feed1' } })]), datasets: [ds({ unusedPostable: 99 })] });
  assert.equal(feed[0].check, 'series_paused');
  assert.deepEqual(feed[0].fix, resume(), 'a no_material pause may always be resumed by hand');
});

// ── source_unreachable ──────────────────────────────────────────────────────────────────────────────────────────────

const feedCard = { id: 'feed1', kind: 'rss', ref: 'https://example.com/feed.xml' } as CardSource;
const feedPlaybook = () => mkPlaybook([mkSeries({ name: 'Feed', source: { kind: 'feed', ref: 'feed1' } })]);
const unreachable = (src: { hostBlock: unknown; lastSuccessAt: string | null } | null) => run({
  pauses: [pause({ key: 'series:Feed', label: 'Feed', cause: 'source_unreachable' })],
  card: { sources: [feedCard] }, playbook: feedPlaybook(),
  sources: src ? [{ url: 'https://example.com/feed.xml', kind: 'rss', origin: 'series:Feed', host: 'example.com', hostBlock: src.hostBlock as never, lastSuccessAt: src.lastSuccessAt }] : [],
});
const NEWER = new Date(PAUSED_AT.getTime() + 3_600_000).toISOString();
const OLDER = new Date(PAUSED_AT.getTime() - 3_600_000).toISOString();
const BLOCK = { reason: 'timeout', until: new Date(NOW.getTime() + 3_600_000).toISOString(), strikes: 1 };

test('source_unreachable is gone only with no block now and a success after the pause', () => {
  const [x] = unreachable({ hostBlock: null, lastSuccessAt: NEWER });
  assert.equal(x.check, 'pause_cause_gone');
  assert.equal(x.severity, 'warn');
  assert.deepEqual(x.fix, resume());
  assert.equal((x.evidence as any).last_success_at, NEWER);
  assert.match(x.detail, /example\.com answered again on 2026-10-17 and nothing blocks it now/);
});

test('every other case of source_unreachable is info without a fix (the banner keeps its own Resume)', () => {
  for (const src of [
    { hostBlock: null, lastSuccessAt: null },
    { hostBlock: null, lastSuccessAt: OLDER },
    { hostBlock: null, lastSuccessAt: PAUSED_AT.toISOString() },
    { hostBlock: BLOCK, lastSuccessAt: NEWER },
    { hostBlock: BLOCK, lastSuccessAt: null },
    null,
  ]) {
    const [x] = unreachable(src);
    assert.equal(x.check, 'series_paused', JSON.stringify(src));
    assert.equal(x.severity, 'info');
    assert.equal(x.fix, undefined);
    assert.match(x.detail, /its source could not be reached/);
  }
});

test('W1: lastSuccessAt is null in the loader, so source_unreachable never becomes pause_cause_gone', () => {
  const f = makeFacts({ pauses: [pause({ key: 'series:Feed', label: 'Feed', cause: 'source_unreachable' })], card: { sources: [feedCard] }, playbook: feedPlaybook() });
  assert.ok(f.sources.every((s) => !s.lastSuccessAt));
  assert.equal(pausesCheck.run(f)[0].check, 'series_paused');
});

// ── shape ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test('each pause is its own finding with its own key; a resumed one is skipped', () => {
  const out = run({ pauses: [pause(), pause({ id: 'p2', cause: 'owner', key: 'series:Other', label: 'Other' }), pause({ id: 'p3', resumedAt: NOW })], playbook: prompt(), datasets: [ds()] });
  assert.deepEqual(out.map((f) => f.subject.id).sort(), ['p1', 'p2']);
  assert.notEqual(out[0].key, out[1].key);
});

test('no pause, no finding', () => {
  assert.deepEqual(run({}), []);
});
