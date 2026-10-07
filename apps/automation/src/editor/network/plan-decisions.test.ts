/**
 * Spec 024 T3 (FR-006): per-resource decisions in submit_network_plan —
 * one decision per idea × resource, auto-skip at cap, from_slot rules, no
 * chains, hard-limit format checks, gap 0 and any direction allowed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Playbook, PlaybookSchema } from './playbook';
import { validateNetworkPlan } from './network-plan';
import type { NetworkCtx } from './network-context';
import type { IdeaRow } from './network.repository';
import { derivedFormatProblem } from '../post/duplicate';

const RES = [
  { ref: 'telegram:@space', platform: 'telegram' as const },
  { ref: 'instagram:ig1', platform: 'instagram' as const },
  { ref: 'threads:th1', platform: 'threads' as const },
];
const pb = (threadsMax = 2): Playbook => PlaybookSchema.parse({
  platforms: [
    { resource_ref: 'telegram:@space', role: 'core', formats: { longread: 0.6, photo: 0.4 }, per_day: { min: 0, max: 3 } },
    { resource_ref: 'instagram:ig1', role: 'funnel_to:telegram:@space', formats: { ig_carousel: 1 }, per_day: { min: 0, max: 2 } },
    { resource_ref: 'threads:th1', role: 'discovery', formats: { th_text: 1 }, per_day: { min: 0, max: threadsMax } },
  ],
});
const net = (o: Partial<NetworkCtx> = {}): NetworkCtx => ({
  orchestrator: { id: 'o1', handle: 'kira' } as any, anchorKey: '@space', groupId: 'g1', groupName: 'Космос', mode: 'independent',
  resources: RES, playbook: pb(), playbookVersion: 1, telegramFormats: ['text', 'photo', 'carousel', 'longread'], ...o,
});
const I1 = '00000000-0000-4000-8000-000000000001';
const I2 = '00000000-0000-4000-8000-000000000002';
const idea = (id: string): IdeaRow => ({
  id, agentId: 'o1', title: `Ідея ${id.slice(-1)}`, angle: null, sources: ['https://x'], variants: [], why: null, evidence: null,
  origin: 'orchestrator', originRef: null, expiresAt: new Date(), status: 'accepted', revisions: 0, review: null, createdAt: new Date(), updatedAt: new Date(),
});
const card = { channelKey: '@space', timezone: 'Europe/Kyiv', quietStartHour: 23, quietEndHour: 8, minGapMinutes: 60 };
const NOW = new Date('2026-10-05T05:00:00Z'); // Monday 08:00 Kyiv
const R = 'Причина з профілю ресурсу';
type S = Record<string, unknown>;
const tg = (o: S = {}) => ({ resource_ref: 'telegram:@space', time: '10:00', format: 'photo', topic: 'Кільця Сатурна', idea_id: I1, source_hints: [], reason: R, ...o });
const ig = (o: S = {}) => ({ resource_ref: 'instagram:ig1', time: '10:00', format: 'ig_carousel', topic: 'Кільця Сатурна', idea_id: I1, source_hints: [], reason: R, ...o });
const th = (o: S = {}) => ({ resource_ref: 'threads:th1', time: '12:00', format: 'th_text', topic: 'Кільця Сатурна', idea_id: I1, source_hints: [], reason: R, ...o });
const run = (slots: S[], skips: S[] = [], o: { net?: NetworkCtx; decided?: Map<string, Set<string>>; ideas?: string[] } = {}) =>
  validateNetworkPlan({ rationale: 'День мережі за рішеннями', slots: slots as any, skips: skips as any }, {
    net: o.net ?? net(), card, planDate: '2026-10-05', weekday: 1, now: NOW,
    ideas: new Map((o.ideas ?? [I1, I2]).map((id) => [id, idea(id)])), reservedAt: [], decided: o.decided,
  });
const errs = (v: ReturnType<typeof run>) => (v.ok ? '' : v.errors.join('\n'));

test('duplicate at the same time (gap 0) and adapt later are valid; derived slots map to their source', () => {
  const v = run([tg(), ig({ treatment: 'duplicate', from_slot: 1, format: 'ig_photo' }), th({ treatment: 'adapt', from_slot: 1, format_notes: 'коротко, без емодзі' })]);
  assert.equal(v.ok, true, errs(v));
  if (!v.ok) return;
  assert.deepEqual(v.slots.map((s) => [s.treatment, s.fromIndex]), [['unique', null], ['duplicate', 0], ['adapt', 0]]);
  assert.equal(v.slots[2].formatNotes, 'коротко, без емодзі');
  // ig_photo is not in the playbook — a derived slot only has to be possible on the platform (rule d is for unique).
  assert.equal(v.slots[1].format, 'ig_photo');
  assert.deepEqual(v.decisions.map((d) => [d.resourceRef, d.decision, d.slotIndex, d.decidedBy]), [
    ['telegram:@space', 'unique', 0, 'planner'], ['instagram:ig1', 'duplicate', 1, 'planner'], ['threads:th1', 'adapt', 2, 'planner'],
  ]);
});

test('any direction: a native Instagram post duplicated into Telegram', () => {
  const v = run([ig({ time: '09:00' }), tg({ treatment: 'duplicate', from_slot: 1, format: 'carousel', time: '09:00' }), th({ treatment: 'adapt', from_slot: 1 })]);
  assert.equal(v.ok, true, errs(v));
});

test('from_slot rules: required, existing, not itself, unique source (no chains), same idea, other resource, not earlier', () => {
  assert.match(errs(run([tg(), ig({ treatment: 'duplicate' }), th({ treatment: 'adapt', from_slot: 1 })])), /duplicate потребує from_slot/);
  assert.match(errs(run([tg(), ig({ treatment: 'duplicate', from_slot: 9 }), th({ treatment: 'adapt', from_slot: 1 })])), /from_slot 9 — немає такого слота/);
  assert.match(errs(run([tg(), ig({ treatment: 'duplicate', from_slot: 2 }), th({ treatment: 'adapt', from_slot: 1 })])), /from_slot 2 — немає такого слота/);
  assert.match(errs(run([tg(), ig({ treatment: 'duplicate', from_slot: 1, format: 'ig_photo' }), th({ treatment: 'adapt', from_slot: 2 })])), /ланцюжки заборонені/);
  assert.match(errs(run([tg(), ig({ treatment: 'duplicate', from_slot: 1, idea_id: I2, format: 'ig_photo' }), th({ treatment: 'adapt', from_slot: 1 })], [], {})), /інша ідея/);
  assert.match(errs(run([tg(), tg({ time: '12:00', treatment: 'duplicate', from_slot: 1 }), ig(), th()])), /джерело на тому самому ресурсі/);
  assert.match(errs(run([tg({ time: '12:00' }), ig({ treatment: 'duplicate', from_slot: 1, format: 'ig_photo', time: '11:00' }), th({ treatment: 'adapt', from_slot: 1 })])), /не раніше за джерело/);
  assert.match(errs(run([tg({ from_slot: 2 }), ig(), th()])), /from_slot лише для duplicate\/adapt/);
});

test('hard-limit format checks only: impossible targets → unsupported_format', () => {
  // A Telegram text post carries at most one image: an Instagram carousel needs 2+.
  assert.match(errs(run([tg({ format: 'longread' }), ig({ treatment: 'duplicate', from_slot: 1, format: 'ig_carousel' }), th()])), /unsupported_format — ig_carousel needs 2\+ images/);
  // Threads text has no media: TikTok photo mode needs one → a duplicate is impossible, an adapt (slides by the agent) is fine.
  assert.equal(derivedFormatProblem({ platform: 'threads', format: 'th_text' }, { platform: 'tiktok', format: 'tt_photo' }, 'duplicate'), 'tt_photo needs 1+ image(s) and th_text carries none');
  assert.equal(derivedFormatProblem({ platform: 'threads', format: 'th_text' }, { platform: 'tiktok', format: 'tt_photo' }, 'adapt'), null);
  // A format the platform cannot publish yet, a video target without video, a poll from a photo.
  assert.match(String(derivedFormatProblem({ platform: 'telegram', format: 'video' }, { platform: 'instagram', format: 'ig_reel' }, 'duplicate')), /not available/);
  assert.match(String(derivedFormatProblem({ platform: 'telegram', format: 'photo' }, { platform: 'telegram', format: 'video' }, 'adapt')), /needs a video/);
  assert.match(String(derivedFormatProblem({ platform: 'telegram', format: 'photo' }, { platform: 'telegram', format: 'poll' }, 'duplicate')), /poll options/);
  // Dropping media is always possible; a real source with two slides fills a carousel.
  assert.equal(derivedFormatProblem({ platform: 'instagram', format: 'ig_carousel' }, { platform: 'threads', format: 'th_text' }, 'duplicate'), null);
  assert.equal(derivedFormatProblem({ platform: 'telegram', format: 'text' }, { platform: 'instagram', format: 'ig_carousel' }, 'duplicate', { images: 0, videos: 0, slides: 2 }), null);
  assert.match(String(derivedFormatProblem({ platform: 'telegram', format: 'text' }, { platform: 'instagram', format: 'ig_photo' }, 'duplicate', { images: 0, videos: 0, slides: 0 })), /the source has 0/);
});

test('one decision per idea × resource: missing, double, skips, reasons', () => {
  assert.match(errs(run([tg(), ig()])), /немає рішення для threads:th1/);
  assert.match(errs(run([tg(), ig(), th()], [{ idea_id: I1, resource_ref: 'threads:th1', reason: 'Не та аудиторія для Threads' }])), /для threads:th1 має бути одне рішення, а є 2/);
  assert.match(errs(run([tg({ reason: undefined }), ig(), th()])), /потрібен reason/);
  assert.match(errs(run([tg(), ig(), th()], [{ idea_id: I2, resource_ref: 'threads:th1', reason: 'Ідеї немає в цьому плані' }])), /ідеї немає в цьому плані/);
  assert.match(errs(run([tg(), ig(), th()], [{ idea_id: I1, resource_ref: 'tiktok:x', reason: 'Ресурс не з цієї мережі' }])), /tiktok:x: ресурс не в мережі/);
  const v = run([tg(), ig()], [{ idea_id: I1, resource_ref: 'threads:th1', reason: 'Профіль Threads без космосу', reason_code: 'off_topic' }]);
  assert.equal(v.ok, true, errs(v));
  if (v.ok) assert.deepEqual(v.decisions.find((d) => d.resourceRef === 'threads:th1'), {
    ideaId: I1, resourceRef: 'threads:th1', decision: 'skip', reason: 'Профіль Threads без космосу', reasonCode: 'off_topic', slotIndex: null, decidedBy: 'planner',
  });
});

test('a resource already at per_day.max gets an automatic cadence skip', () => {
  const full = net({ playbook: pb(1) });
  const v = run([
    th({ idea_id: I2, time: '09:00' }),
    tg(), ig(),
  ], [
    { idea_id: I2, resource_ref: 'telegram:@space', reason: 'Telegram вже має цю тему вчора' },
    { idea_id: I2, resource_ref: 'instagram:ig1', reason: 'Для IG тема без візуалу' },
  ], { net: full });
  assert.equal(v.ok, true, errs(v));
  if (v.ok) {
    const auto = v.decisions.find((d) => d.ideaId === I1 && d.resourceRef === 'threads:th1')!;
    assert.deepEqual([auto.decision, auto.reasonCode, auto.decidedBy], ['skip', 'cadence', 'system']);
    assert.match(auto.reason, /cadence full: 1\/1/);
  }
});

test('decisions made earlier by repurpose_post / the owner count and cannot be doubled', () => {
  const decided = new Map([[I1, new Set(['threads:th1'])]]);
  assert.equal(run([tg(), ig()], [], { decided }).ok, true);
  assert.match(errs(run([tg(), ig(), th()], [], { decided })), /для threads:th1 вже є рішення/);
});
