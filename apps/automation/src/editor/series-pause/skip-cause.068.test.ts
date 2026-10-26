// Spec 068 FR-001 / FR-002 / FR-003 / FR-010 on fakes: the cause the executor names, the classifier (new rows first, then the
// 14-day window of older free text, Cyrillic-safe), the streak families (critic closes transparent), and the replay of the
// review-4 stage export: Prompt, pdr and «AI-новини дня» are paused, a story repeat stays `other`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyClose, reasonLine, type SlotClose } from './skip-cause';
import { skipStreaks, type StreakHit, type StreakSlot } from './streak';
import { skipLine } from './series-pauses.repository';
import {
  agentCauseOf, CONTENT_FAILURE_CODES, isContentFailureCode, isCriticRejection, preflightCauseOf, SKIP_SLOT_CAUSES, skipGroupOf, skipSlotError,
} from '../silent/skip-reasons';
import { ideaOutcomeOf } from '../network/idea-outcome';
import { REVIEW4_SLOTS, type Review4Slot } from './fixtures/review4-skips';

const LETTER: Record<string, string> = { no_material: 'N', source_used: 'S', source_unreachable: 'U', critic: 'C', quality: 'Q' };
const letter = (c: SlotClose): string => c.k === 'cause' ? LETTER[c.cause] : c.k === 'out' ? 'P' : c.k === 'other' ? 'O' : '-';
const close = (error: string | null, criticVerdict: string | null = null, status = 'skipped') => classifyClose({ status, error, criticVerdict });

const slotOf = (r: Review4Slot): StreakSlot => ({
  id: r.id, channelKey: r.channel, resourceRef: null, seriesName: r.series, scheduleRuleId: null, topic: '',
  scheduledAt: new Date(r.at), updatedAt: new Date(r.at), status: r.status, error: r.error, criticVerdict: r.verdict,
});
const group = (channel: string, series: string | null) => REVIEW4_SLOTS.filter((r) => r.channel === channel && r.series === series).sort((a, b) => a.at.localeCompare(b.at));
/** The breaker's view at `at`: only what was closed by then. */
const hitsAt = (rows: Review4Slot[], at: string, threshold = 3): StreakHit[] => skipStreaks(rows.filter((r) => r.at <= at).map(slotOf), { threshold });
const firstHit = (rows: Review4Slot[]): { at: string; hit: StreakHit } | null => {
  for (const r of rows) { const h = hitsAt(rows, r.at); if (h.length) return { at: r.at, hit: h[0] }; }
  return null;
};

test('068 replay: every skip of the review-4 export gets the class it should (the old classifier read N U U N O N N U N N P O)', () => {
  const run = (rows: Review4Slot[]) => rows.map((r) => letter(close(r.error, r.verdict, r.status))).join('');
  // Prompt: the old classifier broke on «недоступний у бібліотеці» (U) and on the Cyrillic stems (O); one U is left, a missing row.
  assert.equal(run(group('@ai0_prompts_dev', 'Prompt')), 'NNNNNNNUNNPN');
  // pdr: two «source_already_posted» sentences are now `source_used`; critic closes are C.
  assert.equal(run(group('@pdr_dev_channel', null)), 'SNSNCNNCPUNU');
  assert.equal(run(group('@ai0_global', 'AI-новини дня')), 'NCNNC');
  // The story repeat is an editorial decision, not a missing source: it must stay `other` (an early draft turned it into N).
  assert.deepEqual(close(REVIEW4_SLOTS.find((r) => r.id === '89320f09')!.error), { k: 'other' });
  // The two resource slots of @game_exchange_dev that came from free text: «не завантажується / 403» is a dead host, a spent source is not.
  const gx = group('@game_exchange_dev', null);
  assert.equal(letter(close(gx.find((r) => r.id === 'eaff17d4')!.error)), 'N');
  assert.equal(letter(close(gx.find((r) => r.id === '9ab177cf')!.error)), 'U');
  assert.equal(letter(close(gx.find((r) => r.id === '756dfc74')!.error)), '-', 'a missing format is infra: ignored');
});

test('068 replay: Prompt is paused from its third dead slot, with the deploy-day streak of 4', () => {
  const rows = group('@ai0_prompts_dev', 'Prompt');
  const first = firstHit(rows)!;
  assert.equal(first.at, '2026-10-22T09:00:00.000Z');
  assert.equal(first.hit.n, 3);
  assert.equal(first.hit.cause, 'no_material');
  assert.equal(first.hit.key, 'series:Prompt');
  // The breaker's first check after the 060 deploy (10-22 18:49) saw four dead slots.
  assert.equal(hitsAt(rows, '2026-10-22T18:49:00.000Z')[0].n, 4);
  // The run is still alive when the whole week is replayed: the post of 10-26 10:00 ended it, one more dead slot is a run of 1.
  assert.deepEqual(hitsAt(rows, '2026-10-26T20:00:00.000Z'), []);
  assert.equal(hitsAt(rows, '2026-10-25T18:00:00.000Z')[0].n, 10, 'all ten dead slots of the week are one run: the unreadable-row slot (U) is in the same family');
});

test('068 replay: pdr is a plain resource — its no_material / source_used run pauses it; after the post, U N U does not', () => {
  const rows = group('@pdr_dev_channel', null);
  const first = firstHit(rows)!;
  assert.equal(first.at, '2026-10-22T06:00:00.000Z', 'S N S spans 23 h');
  assert.equal(first.hit.kind, 'resource');
  assert.equal(first.hit.cause, 'no_material');
  assert.equal(first.hit.n, 3);
  // At the deploy check (10-22 18:49): S N S N — four.
  assert.equal(hitsAt(rows, '2026-10-22T18:49:00.000Z')[0].n, 4);
  // The critic closes of 10-23/24 are transparent, so the run goes on to six on 10-24 06:00 (…S N S N [C] N N).
  assert.equal(hitsAt(rows, '2026-10-24T06:00:00.000Z')[0].n, 6);
  // After the 10-25 post: U (host) · N · U — a source that cannot be read is apart from an empty one; no pause.
  assert.deepEqual(hitsAt(rows, '2026-10-26T20:00:00.000Z'), []);
});

test('068 replay: «AI-новини дня» (N C N N C) is paused on 10-24 09:00 because the critic is transparent', () => {
  const rows = group('@ai0_global', 'AI-новини дня');
  const first = firstHit(rows)!;
  assert.equal(first.at, '2026-10-24T09:00:00.000Z');
  assert.equal(first.hit.n, 3);
  assert.deepEqual(first.hit.slotIds, ['0448497e', 'a877f3ce', '1fb75a76']);
  // Three plain critic rejections alone never make a hit.
  const critics = [1, 2, 3].map((i) => slotOf({ id: `c${i}`, channel: '@x', series: 'S', at: `2026-10-2${i}T09:00:00.000Z`, status: 'skipped', verdict: 'reject', error: 'critic_rejected: reject (sense 1)' }));
  assert.deepEqual(skipStreaks(critics, { threshold: 3 }), []);
});

test('068 replay: @game_exchange_dev stays unpaused (its posts end every run) and a single «Знижки тижня» skip is no streak', () => {
  const gx = group('@game_exchange_dev', null);
  assert.equal(firstHit(gx), null);
  assert.deepEqual(hitsAt(group('@game_exchange_dev', 'Знижки тижня'), '2026-10-26T20:00:00.000Z'), []);
});

test('068 Cyrillic regressions: JS \\w never matched an ending, [\\p{L}] does', () => {
  const agent = (t: string) => letter(close(`skipped by agent: ${t}`));
  assert.equal(agent('немає вільних рядків для цієї теми'), 'N');
  assert.equal(agent('усі закінчилися рядки в бібліотеці'), 'N');
  assert.equal(agent('не знайшла свіжих новин за останні 8 годин'), 'N');
  assert.equal(agent('немає непублікованих записів про фентезі'), 'N');
  assert.equal(agent('не знайшов першоджерела з текстом пункту'), 'N');
  // A library / row context beats «недоступн»: it is a missing row, not a dead host ...
  assert.equal(agent('Запис data://prompts/49392 недоступний у бібліотеці: пошук порожній'), 'N');
  // ... while a dead host is still a dead host.
  assert.equal(agent('zakon.rada.gov.ua недоступний, цитату перевірити не вдалося'), 'U');
  assert.equal(agent('web_fetch 403 на джерелі'), 'U');
});

test('068 the guard codes inside an agent sentence say the source was already posted', () => {
  assert.equal(letter(close('skipped by agent: публікація повернула source_already_posted — джерело вже використано')), 'S');
  assert.equal(letter(close('skipped by agent: рядок 7 повернув library_item_already_posted')), 'S');
  // The anchored forms of the code paths keep their class (a streak does not tell the difference).
  assert.equal(letter(close('source_already_posted: https://zakon.rada.gov.ua/laws/show/1306-2001-п')), 'N');
  assert.equal(letter(close('max_steps: no result; last tool error source_already_posted')), 'N');
  assert.equal(letter(close('preflight_source_used: джерело вже використано')), 'N');
});

test('068 FR-001 new rows: the cause the executor named is read first', () => {
  for (const cause of ['no_material', 'source_used', 'source_unreachable', 'quality']) {
    const c = close(skipSlotError('будь-який текст про 403 і порожній рядок', cause as any));
    assert.deepEqual(c, { k: 'cause', cause }, cause);
  }
  assert.deepEqual(close(skipSlotError('тема не пасує', 'other')), { k: 'other' });
  // The cause wins over the words of the reason.
  assert.equal(letter(close('skipped by agent: quality: у джерелі немає даних, обрізаний текст')), 'Q');
  assert.equal(letter(close('skipped by agent: source_unreachable: нічого свіжого немає')), 'U');
  // A code keeps the old form: no_fresh_item is no_material, story_skip is other.
  assert.equal(letter(close(skipSlotError('нічого', undefined, 'no_fresh_item'))), 'N');
  assert.equal(letter(close(skipSlotError('сусід уже розповів, у бібліотеці немає записів', undefined, 'story_skip'))), 'O');
  assert.deepEqual(SKIP_SLOT_CAUSES, ['no_material', 'source_unreachable', 'source_used', 'quality', 'other']);
  assert.equal(agentCauseOf('skipped by agent: source_used: x'), 'source_used');
  assert.equal(agentCauseOf('skipped by agent: x'), null);
  assert.equal(agentCauseOf('no_material: x'), null);
});

test('068 A2: the order — a critic skip stays the critic\'s, whatever cause the executor named', () => {
  assert.deepEqual(close('skipped by agent: no_material: x', 'revise'), { k: 'cause', cause: 'critic' });
  assert.deepEqual(close('skipped by agent: source_unreachable: x', 'reject'), { k: 'cause', cause: 'critic' });
  assert.ok(isCriticRejection('skipped by agent: no_material: x', 'revise'));
  assert.equal(skipGroupOf('skipped by agent: no_material: x', 'revise'), 'critic');
  // Not a miss / owner / budget / paused beat everything.
  assert.deepEqual(close('superseded by a new plan'), { k: 'ignore' });
  assert.deepEqual(close('series_paused: "Prompt" is paused'), { k: 'ignore' });
  assert.deepEqual(close('budget_exceeded'), { k: 'ignore' });
  // A story the network already told is editorial, before the executor's cause.
  assert.deepEqual(close('skipped by agent: no_material: хоча це story_repeat'), { k: 'other' });
});

test('068 FR-002 new codes: planner and pre-flight reasons classify by prefix, none is "not a miss"', () => {
  assert.deepEqual(close('planner_no_material: у бібліотеці немає рядків з prompt_text'), { k: 'cause', cause: 'no_material' });
  assert.deepEqual(close('planner_source_unreachable: openai.com віддає 403'), { k: 'cause', cause: 'source_unreachable' });
  assert.deepEqual(close('preflight_no_material: рядок data://prompts/1 не знайдено'), { k: 'cause', cause: 'no_material' });
  // The planner's own words may mention a story; its code still decides.
  assert.deepEqual(close('planner_no_material: історія вже була (story_repeat), іншого матеріалу немає'), { k: 'cause', cause: 'no_material' });
  for (const e of ['planner_no_material: x', 'planner_source_unreachable: x', 'preflight_no_material: x']) {
    assert.equal(skipGroupOf(e), 'nothing_fresh', e);
  }
  assert.equal(preflightCauseOf('preflight_no_material: x'), 'no_material');
  assert.equal(ideaOutcomeOf('skipped', 'preflight_no_material: x').status, 'rejected');
  assert.equal(ideaOutcomeOf('skipped', 'planner_no_material: x').status, 'rejected');
});

test('068 A4: an agent\'s material cause is nothing_fresh in the groups, quality and other stay other; not_next_in_order is a lint-group content failure', () => {
  for (const c of ['no_material', 'source_used', 'source_unreachable']) assert.equal(skipGroupOf(`skipped by agent: ${c}: x`, null), 'nothing_fresh', c);
  assert.equal(skipGroupOf('skipped by agent: quality: x', null), 'other');
  assert.equal(skipGroupOf('skipped by agent: other: x', null), 'other');
  assert.equal(skipGroupOf('skipped by agent: старий текст без причини', null), 'other', 'older rows are read by the classifier, not the groups');
  assert.equal(ideaOutcomeOf('skipped', 'skipped by agent: no_material: x', null).status, 'rejected');
  assert.equal(ideaOutcomeOf('skipped', 'skipped by agent: quality: x', null).status, 'used');
  assert.equal(skipGroupOf('not_next_in_order: рядок 7 не за порядком', null), 'lint');
  assert.ok(isContentFailureCode('not_next_in_order'));
  assert.ok((CONTENT_FAILURE_CODES as readonly string[]).includes('not_next_in_order'));
  assert.deepEqual(close('not_next_in_order: рядок 7 не за порядком'), { k: 'other' }, 'the streak counter: not a dead series');
});

test('068 FR-003 families: series merge all three; a plain resource keeps an unreadable source apart; quality and other end a run', () => {
  const at = (h: number) => new Date(Date.parse('2026-10-22T00:00:00Z') + h * 3600_000);
  const mk = (kind: 'series' | 'resource', errs: string[], gapH = 10): StreakSlot[] => errs.map((error, i) => ({
    id: `x${i}`, channelKey: '@c', resourceRef: null, seriesName: kind === 'series' ? 'S' : null, scheduleRuleId: null, topic: '',
    scheduledAt: at(i * gapH), updatedAt: at(i * gapH), status: 'skipped', error, criticVerdict: null,
  }));
  const N = 'skipped by agent: no_material: x', S = 'skipped by agent: source_used: x', U = 'skipped by agent: source_unreachable: x';
  const Q = 'skipped by agent: quality: x', O = 'skipped by agent: other: x';
  const hit = (kind: 'series' | 'resource', ...errs: string[]) => skipStreaks(mk(kind, errs), { threshold: 3 });
  // Series: any mix of the three counts; the cause is no_material when any member is no_material / source_used.
  assert.equal(hit('series', N, S, U)[0].cause, 'no_material');
  assert.equal(hit('series', U, U, S)[0].cause, 'no_material');
  assert.equal(hit('series', U, U, U)[0].cause, 'source_unreachable', 'a run of unreachable skips still pauses (060)');
  // Resource: N and S are one family, U is apart, and the 20 h span stays.
  assert.equal(hit('resource', N, S, N)[0].cause, 'no_material');
  assert.equal(hit('resource', N, U, N, N).length, 0, 'N U N N is a run of 2');
  assert.equal(hit('resource', U, U, U)[0].cause, 'source_unreachable');
  assert.equal(skipStreaks(mk('resource', [N, S, N], 5), { threshold: 3 }).length, 0, '3 skips in 10 h are one quiet evening');
  // Quality and other end a run; so does a post.
  assert.equal(hit('series', N, N, Q, N).length, 0);
  assert.equal(hit('series', N, N, O, N).length, 0);
  assert.equal(hit('series', N, N, Q, N, N, N)[0].n, 3);
  const withPost = mk('series', [N, N, N, N]);
  withPost[2].status = 'published';
  withPost[2].error = null;
  assert.equal(skipStreaks(withPost, { threshold: 3 }).length, 0);
});

test('068 the cause prefix round-trips through the readers of the error text', () => {
  const e = skipSlotError('рядок data://prompts/7 без prompt_text', 'no_material');
  assert.equal(e, 'skipped by agent: no_material: рядок data://prompts/7 без prompt_text');
  assert.equal(reasonLine(e), 'no_material: рядок data://prompts/7 без prompt_text', 'the prefix is dropped, the cause stays for the owner');
  assert.equal(skipLine(e), 'skipped: no_material: рядок data://prompts/7 без prompt_text');
  assert.ok(isCriticRejection(e, 'revise'));
  assert.ok(!isCriticRejection(e, null));
  assert.match(e, /^skipped by agent: /, 'landing-pulse (LIKE \'skipped by agent:%\') and the dashboard read the prefix');
});
