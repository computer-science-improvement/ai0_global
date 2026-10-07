/**
 * Spec 024 T2: per-resource time zones — the resolver's fallback order, the
 * profile fields, strict wall-clock → instant conversion across DST (Kyiv and
 * New York switch on different weekends), the network planner in resource
 * zones, and the prompt lines. Owner-facing times stay Kyiv.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_QUIET, isValidTimeZone, resolveQuiet, resolveTz, resourceTimeLines, ResourceTime, zonedToUtcStrict,
} from './resource-time';
import { ResourceProfilesRepository, ResourceProfileSchema, renderProfile } from '../agents/resource-profile';
import { validateNetworkPlan } from '../network/network-plan';
import { networkContext, NetworkCtx } from '../network/network-context';
import { networkPlannerBlock, orchestratorDailyPrompt } from '../network/network-prompts';
import { PlaybookSchema } from '../network/playbook';
import { buildComposerSystemPrompt } from '../roles/prompts';
import { makeCard } from '../post/testing/fixtures';
import type { IdeaRow } from '../network/network.repository';

const NY = 'America/New_York';
const KYIV = 'Europe/Kyiv';
const iso = (d: Date | null) => d?.toISOString() ?? null;

// ── resolver ───────────────────────────────────────────────────────────────

test('isValidTimeZone: IANA zones only', () => {
  for (const z of [KYIV, NY, 'UTC', 'Asia/Tokyo']) assert.equal(isValidTimeZone(z), true, z);
  for (const z of ['Mars/Olympus', '', '  ', null, 42, 'Kyiv']) assert.equal(isValidTimeZone(z), false, String(z));
});

test('resolveTz: Telegram card → profile → Kyiv; other refs profile → Kyiv; invalid → Kyiv (flagged)', () => {
  const card = { timezone: NY };
  const prof = { timezone: 'Asia/Tokyo' };
  assert.deepEqual(resolveTz('telegram:@a', card, prof), { tz: NY }, 'the card is authoritative for Telegram');
  assert.deepEqual(resolveTz('telegram:@a', null, prof), { tz: 'Asia/Tokyo' }, 'no card → profile');
  assert.deepEqual(resolveTz('telegram:@a', { timezone: '' }, null), { tz: KYIV });
  assert.deepEqual(resolveTz('instagram:1', card, prof), { tz: 'Asia/Tokyo' }, 'cards never apply to platform refs');
  assert.deepEqual(resolveTz('instagram:1', null, null), { tz: KYIV });
  assert.deepEqual(resolveTz('instagram:1', null, {}), { tz: KYIV });
  assert.deepEqual(resolveTz('threads:1', null, { timezone: 'Mars/Olympus' }), { tz: KYIV, invalid: 'Mars/Olympus' });
  assert.deepEqual(resolveTz('telegram:@a', { timezone: 'Nope/Nope' }, prof), { tz: KYIV, invalid: 'Nope/Nope' });
});

test('resolveQuiet: Telegram card hours, else the profile, else 23→8', () => {
  assert.deepEqual(resolveQuiet('telegram:@a', { quietStartHour: 22, quietEndHour: 7 }, { quiet_hours: { start: 1, end: 2 } }), { start: 22, end: 7 });
  assert.deepEqual(resolveQuiet('instagram:1', { quietStartHour: 22, quietEndHour: 7 }, { quiet_hours: { start: 0, end: 6 } }), { start: 0, end: 6 });
  assert.deepEqual(resolveQuiet('instagram:1', null, null), DEFAULT_QUIET);
  assert.deepEqual(resolveQuiet('instagram:1', null, { quiet_hours: { start: 25, end: 6 } as any }), DEFAULT_QUIET);
});

test('ResourceTime: tzOf / quietOf / localDay with a warning for an invalid stored zone', async () => {
  const warned: string[] = [];
  const rt = new ResourceTime({
    card: async (k) => (k === '@ny' ? { timezone: NY, quietStartHour: 22, quietEndHour: 6 } : null),
    profile: async (ref) => (ref === 'instagram:bad' ? { timezone: 'Mars/Olympus' } : ref === 'instagram:la' ? { timezone: 'America/Los_Angeles', quiet_hours: { start: 0, end: 7 } } : null),
    warn: (ref, d) => { warned.push(`${ref}: ${d}`); },
  });
  assert.equal(await rt.tzOf('telegram:@ny'), NY);
  assert.deepEqual(await rt.quietOf('telegram:@ny'), { start: 22, end: 6 });
  assert.equal(await rt.tzOf('telegram:@none'), KYIV);
  assert.equal(await rt.tzOf('instagram:la'), 'America/Los_Angeles');
  assert.deepEqual(await rt.quietOf('instagram:la'), { start: 0, end: 7 });
  assert.equal(await rt.tzOf('instagram:bad'), KYIV);
  assert.match(warned[0], /instagram:bad: invalid time zone "Mars\/Olympus", using Europe\/Kyiv/);
  // 2026-10-07 02:30Z: still Oct 6 in New York, already Oct 7 in Kyiv.
  const t = new Date('2026-10-07T02:30:00Z');
  assert.equal(await rt.localDay('telegram:@ny', t), '2026-10-06');
  assert.equal(await rt.localDay('instagram:none', t), '2026-10-07');
});

// ── strict conversion and DST ──────────────────────────────────────────────

test('a New York 09:00 slot is 13:00 UTC in summer time and 14:00 UTC in winter time', () => {
  assert.equal(iso(zonedToUtcStrict('2026-07-01', '09:00', NY)), '2026-07-01T13:00:00.000Z');
  assert.equal(iso(zonedToUtcStrict('2026-12-01', '09:00', NY)), '2026-12-01T14:00:00.000Z');
});

test('DST: Kyiv and New York switch on different weekends (spring gap → null, autumn ambiguity → earlier instant)', () => {
  // US spring forward: 2026-03-08 02:00 → 03:00 (New York). Kyiv is still on winter time.
  assert.equal(zonedToUtcStrict('2026-03-08', '02:30', NY), null);
  assert.equal(iso(zonedToUtcStrict('2026-03-08', '02:30', KYIV)), '2026-03-08T00:30:00.000Z');
  // Between the two switches New York is only 6 h behind Kyiv.
  assert.equal(iso(zonedToUtcStrict('2026-03-16', '09:00', NY)), '2026-03-16T13:00:00.000Z');
  assert.equal(iso(zonedToUtcStrict('2026-03-16', '15:00', KYIV)), '2026-03-16T13:00:00.000Z');
  // EU spring forward: 2026-03-29 03:00 → 04:00 (Kyiv). New York is unaffected that day.
  assert.equal(zonedToUtcStrict('2026-03-29', '03:30', KYIV), null);
  assert.equal(iso(zonedToUtcStrict('2026-03-29', '03:30', NY)), '2026-03-29T07:30:00.000Z');
  // EU fall back: 2026-10-25 04:00 → 03:00 (Kyiv): 03:30 happens twice → the earlier (EEST) instant.
  assert.equal(iso(zonedToUtcStrict('2026-10-25', '03:30', KYIV)), '2026-10-25T00:30:00.000Z');
  assert.equal(iso(zonedToUtcStrict('2026-10-25', '03:30', NY)), '2026-10-25T07:30:00.000Z');
  // US fall back: 2026-11-01 02:00 → 01:00 (New York): 01:30 twice → the earlier (EDT) instant.
  assert.equal(iso(zonedToUtcStrict('2026-11-01', '01:30', NY)), '2026-11-01T05:30:00.000Z');
  assert.equal(iso(zonedToUtcStrict('2026-11-01', '01:30', KYIV)), '2026-10-31T23:30:00.000Z');
});

// ── profile fields ─────────────────────────────────────────────────────────

const BASE = { topic: 'Космос і наука', audience: { who: 'дорослі' }, goals: ['growth'] };

test('ResourceProfileSchema: timezone is validated with Intl, quiet hours 0–23; both optional', () => {
  assert.equal(ResourceProfileSchema.safeParse({ ...BASE, timezone: NY, quiet_hours: { start: 23, end: 7 } }).success, true);
  assert.equal(ResourceProfileSchema.parse(BASE).timezone, undefined, 'absent = Europe/Kyiv via the resolver');
  const bad = ResourceProfileSchema.safeParse({ ...BASE, timezone: 'Mars/Olympus' });
  assert.equal(bad.success, false);
  assert.match(JSON.stringify(bad.error?.issues), /unknown IANA time zone/);
  assert.equal(ResourceProfileSchema.safeParse({ ...BASE, quiet_hours: { start: 24, end: 7 } }).success, false);
});

test('a stored profile with an invalid zone keeps the rest of the profile', async () => {
  const repo = new ResourceProfilesRepository({ query: async () => ({ rows: [{ profile: { ...BASE, timezone: 'Mars/Olympus' }, resource_health: null, updated_by: 'owner', updated_at: new Date() }] }) } as any);
  const p = await repo.get('instagram:1');
  assert.equal(p?.profile?.topic, 'Космос і наука');
  assert.equal(p?.profile?.timezone, undefined);
});

test('renderProfile prints the zone line only outside Kyiv and never for Telegram refs', () => {
  const now = new Date('2026-10-06T13:12:00Z');
  const ny = ResourceProfileSchema.parse({ ...BASE, timezone: NY });
  assert.match(renderProfile(ny, { now, ref: 'instagram:1' }), /Часовий пояс: America\/New_York \(зараз 09:12\)/);
  assert.doesNotMatch(renderProfile(ny, { now, ref: 'telegram:@a' }), /Часовий пояс/);
  assert.doesNotMatch(renderProfile(ResourceProfileSchema.parse({ ...BASE, timezone: KYIV }), { now }), /Часовий пояс/);
  assert.doesNotMatch(renderProfile(ResourceProfileSchema.parse(BASE), { now }), /Часовий пояс/);
});

// ── network planner in resource zones ──────────────────────────────────────

const IDEA = '00000000-0000-4000-8000-000000000001';
const playbook = PlaybookSchema.parse({
  platforms: [
    { resource_ref: 'telegram:@space', role: 'core', formats: { text: 1 }, per_day: { min: 0, max: 3 } },
    { resource_ref: 'instagram:ny', role: 'discovery', formats: { ig_carousel: 1 }, per_day: { min: 0, max: 2 }, best_hours: [9, 20] },
  ],
  series: [{ name: 'Вечірній огляд', cadence: 'daily@20:00', resource_ref: 'instagram:ny', format: 'ig_carousel', brief: 'Огляд дня для американської аудиторії' }],
});
const netWith = (tz: Record<string, string> = { 'instagram:ny': NY }): NetworkCtx => ({
  orchestrator: { id: 'o1', handle: 'kira', name: 'Кіра' } as any, anchorKey: '@space', groupId: 'g1', groupName: 'Космос', mode: 'independent',
  resources: [
    { ref: 'telegram:@space', platform: 'telegram', tz: KYIV, quiet: { start: 23, end: 8 } },
    { ref: 'instagram:ny', platform: 'instagram', tz: tz['instagram:ny'] ?? KYIV, quiet: { start: 23, end: 8 } },
  ],
  playbook, playbookVersion: 1, telegramFormats: ['text'],
});
const card = makeCard({ channelKey: '@space' });
const idea = { id: IDEA, variants: [{ resource_ref: 'instagram:ny', format: 'ig_carousel' }] } as unknown as IdeaRow;
const slot = (time: string, o: Record<string, unknown> = {}) => ({ resource_ref: 'instagram:ny', time, format: 'ig_carousel', topic: 'Тема дня про космос', series: 'Вечірній огляд', source_hints: [], ...o });
// Spec 024 T3: an idea in the plan needs a decision on every resource — Telegram skips it here.
const TG_SKIP = [{ idea_id: IDEA, resource_ref: 'telegram:@space', reason: 'Для Telegram ця тема вже була сьогодні' }];
const validate = (slots: any[], planDate: string, now: string, net = netWith()) =>
  validateNetworkPlan({ rationale: 'план на день для мережі', slots, skips: slots.some((s) => s.idea_id) ? TG_SKIP : [] }, {
    net, card, planDate, weekday: new Date(`${planDate}T12:00:00Z`).getUTCDay(), now: new Date(now), ideas: new Map([[IDEA, idea]]), reservedAt: [],
  });

test('submit_network_plan: a slot time is in its resource zone (NY 09:00 → 13:00Z / 14:00Z)', () => {
  const summer = validate([slot('09:00')], '2026-07-01', '2026-07-01T00:00:00Z');
  assert.ok(summer.ok, JSON.stringify(summer));
  assert.equal(summer.ok && summer.slots[0].scheduledAt.toISOString(), '2026-07-01T13:00:00.000Z');
  const winter = validate([slot('09:00')], '2026-12-01', '2026-12-01T00:00:00Z');
  assert.equal(winter.ok && winter.slots[0].scheduledAt.toISOString(), '2026-12-01T14:00:00.000Z');
  // The same slot in a Kyiv-zoned resource keeps the pre-024 meaning.
  const kyiv = validate([slot('09:00')], '2026-07-01', '2026-07-01T00:00:00Z', netWith({ 'instagram:ny': KYIV }));
  assert.equal(kyiv.ok && kyiv.slots[0].scheduledAt.toISOString(), '2026-07-01T06:00:00.000Z');
});

test('submit_network_plan: a time in the DST gap of the resource zone is an error; ambiguous → earlier instant', () => {
  const gap = validate([slot('02:30')], '2026-03-08', '2026-03-07T00:00:00Z', netWith());
  assert.equal(gap.ok, false);
  assert.match((gap as any).errors.join('\n'), /02:30 не існує 2026-03-08 у America\/New_York/);
  // quiet 23→8 forbids 01:30, so use quiet 0→0 (none) for the ambiguity check.
  const open = netWith();
  open.resources[1].quiet = { start: 0, end: 0 };
  const amb = validate([slot('01:30')], '2026-11-01', '2026-10-31T00:00:00Z', open);
  assert.equal(amb.ok && amb.slots[0].scheduledAt.toISOString(), '2026-11-01T05:30:00.000Z');
});

test('submit_network_plan: quiet hours and per_day are counted in the resource local day', () => {
  // 07:00 New York is quiet there (23→8) although it is 14:00 in Kyiv.
  const quiet = validate([slot('07:00')], '2026-07-01', '2026-07-01T00:00:00Z');
  assert.equal(quiet.ok, false);
  assert.match((quiet as any).errors.join('\n'), /тихі години 23:00–8:00 \(America\/New_York\)/);
  // 22:00 New York = 05:00 Kyiv next day: still allowed (not quiet in New York) and on the NY plan date.
  const late = validate([slot('20:00'), slot('22:00', { series: undefined, idea_id: IDEA, reason: 'Нічна аудиторія Нью-Йорка активна' })], '2026-07-01', '2026-07-01T00:00:00Z');
  assert.ok(late.ok, JSON.stringify(late));
  assert.deepEqual(late.ok && late.slots.map((s) => s.scheduledAt.toISOString()), ['2026-07-02T00:00:00.000Z', '2026-07-02T02:00:00.000Z']);
  // Both count towards the NY day: a third slot exceeds per_day.max 2 although the Kyiv dates differ.
  const over = validate([slot('10:00'), slot('20:00'), slot('22:00', { series: undefined, idea_id: IDEA, reason: 'Нічна аудиторія Нью-Йорка активна' })], '2026-07-01', '2026-07-01T00:00:00Z');
  assert.equal(over.ok, false);
  assert.match((over as any).errors.join('\n'), /instagram:ny: 3 постів > per_day.max 2/);
});

test('networkContext: resolver zones when wired; otherwise the card for Telegram and Kyiv for the rest', async () => {
  const repo = {
    groupOfChannel: async () => ({ id: 'g1', name: 'Космос', mode: 'independent' as const }),
    groupResources: async () => [{ ref: 'telegram:@space', platform: 'telegram', title: null }, { ref: 'instagram:ny', platform: 'instagram', title: null }],
    activePlaybook: async () => null,
  };
  const orch = { id: 'o1', scope: 'resource', scopeId: 'telegram:@space' } as any;
  const nyCard = makeCard({ channelKey: '@space', timezone: 'Europe/Warsaw', quietStartHour: 22, quietEndHour: 7 });
  const plain = await networkContext({ repo }, orch, nyCard);
  assert.deepEqual(plain!.resources.map((r) => [r.ref, r.tz, r.quiet]), [
    ['telegram:@space', 'Europe/Warsaw', { start: 22, end: 7 }], ['instagram:ny', KYIV, { start: 23, end: 8 }],
  ]);
  const time = { tzOf: async (ref: string) => (ref === 'instagram:ny' ? NY : 'Europe/Warsaw'), quietOf: async () => ({ start: 0, end: 6 }) };
  const wired = await networkContext({ repo, time }, orch, nyCard);
  assert.deepEqual(wired!.resources.map((r) => r.tz), ['Europe/Warsaw', NY]);
});

// ── prompts ────────────────────────────────────────────────────────────────

test('planner and orchestrator prompts show a clock line per non-Kyiv resource; series times carry the zone', () => {
  const now = new Date('2026-10-06T13:12:00Z');
  const block = networkPlannerBlock({ net: netWith(), accepted: [], now, tz: KYIV, planDate: '2026-10-07' });
  assert.match(block, /## Час ресурсів \(не Київ\)\n- instagram:ny — America\/New_York, зараз 09:12/);
  assert.doesNotMatch(block, /telegram:@space — /);
  assert.match(block, /«Вечірній огляд» о 20:00 \(America\/New_York\) → instagram:ny/);
  assert.match(block, /плануєш день 2026-10-07/);
  const kyivOnly = networkPlannerBlock({ net: netWith({ 'instagram:ny': KYIV }), accepted: [], now, tz: KYIV });
  assert.doesNotMatch(kyivOnly, /Час ресурсів/);
  const daily = orchestratorDailyPrompt({ net: netWith(), card, now, open: [], target: 3, hasDirectives: false });
  assert.match(daily, /instagram:ny — America\/New_York, зараз 09:12/);
});

test('owner-facing time stays Kyiv; a channel in another zone gets its own line in the composer prompt', () => {
  const now = new Date('2026-10-06T13:12:00Z');
  const skills = { get: () => null, list: () => [] } as any;
  const ny = buildComposerSystemPrompt({ now, card: makeCard({ channelKey: '@ny', timezone: NY }), hasCard: true, memory: [], skills });
  assert.match(ny, /Зараз .* 16:12 \(Київ, Europe\/Kyiv\)/);
  assert.match(ny, /Час каналу: telegram:@ny — America\/New_York, зараз 09:12/);
  const kyiv = buildComposerSystemPrompt({ now, card: makeCard({ channelKey: '@k' }), hasCard: true, memory: [], skills });
  assert.doesNotMatch(kyiv, /Час каналу/);
  assert.deepEqual(resourceTimeLines([{ ref: 'a', tz: KYIV }, { ref: 'b', tz: null }, { ref: 'c', tz: 'Mars/Olympus' }], now), []);
});
