/**
 * Spec 034 FR-005: the poll cap in both plan validators — at most `polls_per_week` poll + quiz posts per
 * resource in the 7 days ending on the plan date (already published / planned + the plan), owner series
 * exempt, a quiz resource without a cap unlimited.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exemptSeries, pollCapErrors, windowStartDate, type PollCapCtx } from './poll-cap';
import { validatePlan } from './plan-rules';
import { makeCard } from '../post/testing/fixtures';
import { validateNetworkPlan } from '../network/network-plan';
import { PlaybookSchema } from '../network/playbook';
import type { NetworkCtx } from '../network/network-context';
import type { IdeaRow } from '../network/network.repository';

const ANCHOR = 'telegram:@chan';
const card = makeCard({ postsPerDayMin: 1, postsPerDayMax: 4, minGapMinutes: 60, quietStartHour: 23, quietEndHour: 8, exploreRatio: 0.5 });
const now = new Date('2026-10-01T04:00:00Z'); // 07:00 Kyiv
const slot = (time: string, format: string, extra: Record<string, unknown> = {}) =>
  ({ time, format, topic: 'Тема поста про космос', source_hints: [] as string[], is_experiment: false, ...extra });
const caps = (o: Partial<PollCapCtx> = {}): PollCapCtx => ({ caps: { [ANCHOR]: 1 }, recent: [], defaultRef: ANCHOR, ...o });

test('poll cap window: 7 days ending on the plan date', () => {
  assert.equal(windowStartDate('2026-10-07'), '2026-10-01');
  assert.equal(windowStartDate('2026-03-02'), '2026-02-24');
});

test('single plan: the first poll of the week passes, a second one (published earlier) is refused with the cap named', () => {
  const plan = { rationale: 'Опитування про улюблену планету', slots: [slot('09:00', 'photo'), slot('12:00', 'poll')] };
  const first = validatePlan(plan, card, '2026-10-01', now, [], undefined, [], caps());
  assert.equal(first.ok, true, JSON.stringify(first));

  const second = validatePlan(plan, card, '2026-10-01', now, [], undefined, [], caps({ recent: [{ resourceRef: ANCHOR, series: null }] }));
  assert.equal(second.ok, false);
  const e = (second as { errors: string[] }).errors.join('\n');
  assert.match(e, /опитувань і вікторин за 7 днів було б 2 \(уже 1, у плані 1\)/);
  assert.match(e, /ліміт ресурсу 1 на тиждень \(polls_per_week\)/);
});

test('single plan: two polls (or a poll and a quiz) in one plan exceed the default cap; no cap context = no check', () => {
  const plan = { rationale: 'Забагато опитувань', slots: [slot('09:00', 'poll'), slot('12:00', 'quiz')] };
  const v = validatePlan(plan, card, '2026-10-01', now, [], undefined, [], caps());
  assert.equal(v.ok, false);
  assert.match((v as { errors: string[] }).errors.join('\n'), /було б 2 \(уже 0, у плані 2\)/);
  assert.equal(validatePlan(plan, card, '2026-10-01', now).ok, true, 'callers without the cap context keep the old behaviour');
  // A resource missing from caps gets the default (1).
  assert.equal(validatePlan(plan, card, '2026-10-01', now, [], undefined, [], { caps: {}, recent: [], defaultRef: ANCHOR }).ok, false);
});

test('single plan: a raised cap, a quiz resource (null) and owner series do not count', () => {
  const plan = { rationale: 'Два опитування', slots: [slot('09:00', 'poll'), slot('12:00', 'quiz', { series: 'ПДР щодня' })] };
  assert.equal(validatePlan(plan, card, '2026-10-01', now, [], undefined, [], caps({ caps: { [ANCHOR]: 3 } })).ok, true);
  assert.equal(validatePlan(plan, card, '2026-10-01', now, [], undefined, [], caps({ caps: { [ANCHOR]: null }, recent: Array(9).fill({ resourceRef: ANCHOR, series: null }) })).ok, true);
  // Series exemption goes through pollCapErrors (validatePlan passes the schedule ctx's series).
  const slots = [{ format: 'poll' }, { format: 'quiz', series: 'ПДР щодня' }, { format: 'quiz', sourceHints: ['series:ПДР щодня'] }];
  const series = [{ name: 'ПДР щодня', origin: 'migration' }, { name: 'Агентська', origin: 'agent' }];
  assert.deepEqual(pollCapErrors(slots, caps({ recent: [{ resourceRef: ANCHOR, series: 'ПДР щодня' }] }), series), []);
  assert.equal(pollCapErrors(slots, caps({ recent: [{ resourceRef: ANCHOR, series: 'Агентська' }] }), series).length, 1, 'an agent series counts');
  assert.deepEqual([...exemptSeries([{ name: 'a', origin: 'owner' }, { name: 'b', locked: true }, { name: 'c', origin: 'agent' }])], ['a', 'b']);
});

test('single plan: text and photo never count', () => {
  const plan = { rationale: 'Звичайний день', slots: [slot('09:00', 'photo'), slot('12:00', 'text')] };
  assert.equal(validatePlan(plan, card, '2026-10-01', now, [], undefined, [], caps({ caps: { [ANCHOR]: 0 } })).ok, true);
});

// ── network ──────────────────────────────────────────────────────────────────

const RES = [{ ref: 'telegram:@space', platform: 'telegram' as const }, { ref: 'threads:th1', platform: 'threads' as const }];
const net = (): NetworkCtx => ({
  orchestrator: { id: 'o1', handle: 'kira' } as any, anchorKey: '@space', groupId: 'g1', groupName: 'Космос', mode: 'independent', resources: RES,
  playbook: PlaybookSchema.parse({
    platforms: [
      { resource_ref: 'telegram:@space', role: 'core', formats: { photo: 1, poll: 0.2 }, per_day: { min: 1, max: 4 } },
      { resource_ref: 'threads:th1', role: 'discovery', formats: { th_text: 1 }, per_day: { min: 0, max: 2 } },
    ],
  }),
  playbookVersion: 1, telegramFormats: ['text', 'photo', 'poll', 'quiz'],
});
const I1 = '00000000-0000-4000-8000-000000000001';
const I2 = '00000000-0000-4000-8000-000000000002';
const idea = (id: string): IdeaRow => ({
  id, agentId: 'o1', title: `Ідея ${id}`, angle: null, sources: ['https://x'], variants: [{ resource_ref: 'telegram:@space', format: 'poll' }],
  why: null, evidence: null, origin: 'orchestrator', originRef: null, expiresAt: new Date(), status: 'accepted', revisions: 0, review: null, createdAt: new Date(), updatedAt: new Date(),
});
const netCard = { channelKey: '@space', timezone: 'Europe/Kyiv', quietStartHour: 23, quietEndHour: 8, minGapMinutes: 60 };
const NOW = new Date('2026-10-04T05:00:00Z');
const skipTh = (id: string) => ({ idea_id: id, resource_ref: 'threads:th1', reason: 'Threads: опитування там не працюють', reason_code: 'format_unfit' as const });

test('network plan: a second poll in the week on a resource is refused, other resources are unaffected', () => {
  const plan = {
    rationale: 'Два опитування в Telegram', slots: [
      { resource_ref: 'telegram:@space', time: '10:00', format: 'poll', topic: 'Улюблена планета', idea_id: I1, source_hints: [], reason: 'Ядро мережі' },
      { resource_ref: 'telegram:@space', time: '14:00', format: 'poll', topic: 'Улюблений телескоп', idea_id: I2, source_hints: [], reason: 'Ядро мережі' },
    ],
    skips: [skipTh(I1), skipTh(I2)],
  };
  const o = { net: net(), card: netCard, planDate: '2026-10-04', weekday: 0, now: NOW, ideas: new Map([[I1, idea(I1)], [I2, idea(I2)]]), reservedAt: [] };
  assert.equal(validateNetworkPlan(plan, o).ok, true, 'no cap context: unchanged');
  const refused = validateNetworkPlan(plan, { ...o, pollCap: { caps: { 'telegram:@space': 1, 'threads:th1': 1 }, recent: [] } });
  assert.equal(refused.ok, false);
  const e = (refused as { errors: string[] }).errors.join('\n');
  assert.match(e, /telegram:@space: опитувань і вікторин за 7 днів було б 2/);
  assert.ok(!e.includes('threads:th1: опитувань'), e);

  const one = { ...plan, slots: plan.slots.slice(0, 1), skips: [skipTh(I1)] };
  assert.equal(validateNetworkPlan(one, { ...o, pollCap: { caps: { 'telegram:@space': 1 }, recent: [] } }).ok, true);
  const already = validateNetworkPlan(one, { ...o, pollCap: { caps: { 'telegram:@space': 1 }, recent: [{ resourceRef: 'telegram:@space', series: null }] } });
  assert.equal(already.ok, false, 'a poll published earlier this week counts');
});
