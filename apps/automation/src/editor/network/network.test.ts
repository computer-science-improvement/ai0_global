import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPlaybookChange, Playbook, PlaybookSchema, seriesDue, validatePlaybook } from './playbook';
import { validateNetworkPlan } from './network-plan';
import type { NetworkCtx } from './network-context';
import type { IdeaRow } from './network.repository';

const RES = [{ ref: 'telegram:@space', platform: 'telegram' as const }, { ref: 'instagram:ig1', platform: 'instagram' as const }, { ref: 'threads:th1', platform: 'threads' as const }];
const TG_FORMATS = ['text', 'photo', 'carousel', 'longread'];

const pb = (o: Partial<Playbook> = {}): Playbook => PlaybookSchema.parse({
  platforms: [
    { resource_ref: 'telegram:@space', role: 'core', formats: { longread: 0.6, photo: 0.4 }, per_day: { min: 1, max: 3 }, best_hours: [10, 19] },
    { resource_ref: 'instagram:ig1', role: 'funnel_to:telegram:@space', formats: { ig_carousel: 1 }, per_day: { min: 0, max: 2 }, hashtag_policy: { vocab: ['космос'], min: 3, max: 5 } },
    { resource_ref: 'threads:th1', role: 'discovery', formats: { th_text: 1 }, per_day: { min: 0, max: 2 } },
  ],
  series: [{ name: 'Топ тижня', cadence: 'weekly:sun@10:00', resource_ref: 'instagram:ig1', format: 'ig_carousel', brief: 'Пʼять найкращих новин тижня' }],
  pillars: [{ name: 'Новини', share: 60 }, { name: 'Факти', share: 40 }],
  rules: ['Без астрології'],
  ...o,
});

test('playbook validation: every rule', () => {
  assert.deepEqual(validatePlaybook(pb(), RES, TG_FORMATS), []);
  const bad = pb({
    platforms: [
      { resource_ref: 'telegram:@space', role: 'boss', formats: { reel: 1 }, per_day: { min: 3, max: 1 }, best_hours: [], hashtag_policy: { vocab: [], min: 0, max: 5 } },
      { resource_ref: 'tiktok:x', role: 'core', formats: { tt_photo: 1 }, per_day: { min: 0, max: 1 }, best_hours: [], hashtag_policy: { vocab: [], min: 0, max: 5 } },
      { resource_ref: 'instagram:ig1', role: 'funnel_to:telegram:@nope', formats: { ig_carousel: 1 }, per_day: { min: 0, max: 2 }, best_hours: [], hashtag_policy: { vocab: [], min: 0, max: 5 } },
    ] as any,
    pillars: [{ name: 'Аа', share: 50 }],
  });
  const e = validatePlaybook(bad, RES, TG_FORMATS).join('\n');
  for (const frag of ['формати reel недоступні', 'per_day.min > per_day.max', 'роль boss', 'tiktok:x: ресурс не в цій мережі', 'funnel_to telegram:@nope', '100 ± 5']) {
    assert.ok(e.includes(frag), `${frag}\n${e}`);
  }
  const tt = [...RES, { ref: 'tiktok:t1', platform: 'tiktok' as const }];
  const capped = pb({ platforms: [...pb().platforms, { resource_ref: 'tiktok:t1', role: 'discovery', formats: { tt_photo: 1 }, per_day: { min: 0, max: 20 }, best_hours: [], hashtag_policy: { vocab: [], min: 0, max: 5 } }] });
  assert.ok(validatePlaybook(capped, tt, TG_FORMATS).some((x) => x.includes('ліміту API 15')));
});

test('playbook change classification: minor vs structural', () => {
  const a = pb();
  assert.equal(classifyPlaybookChange(null, a).structural, true);
  const minor = structuredClone(a);
  minor.platforms[0].formats.longread = 0.8;
  minor.platforms[0].best_hours = [9, 20];
  minor.platforms[1].hashtag_policy.vocab = ['космос', 'наука'];
  minor.series[0].active = false;
  assert.deepEqual(classifyPlaybookChange(a, minor), { structural: false, reasons: [] });
  const big = structuredClone(a);
  big.platforms[1].per_day.max = 4;
  big.platforms[0].formats.text = 0.3;
  big.rules.push('Нове правило');
  const r = classifyPlaybookChange(a, big);
  assert.equal(r.structural, true);
  assert.equal(r.reasons.length, 3);
});

test('series due by weekday', () => {
  assert.equal(seriesDue(pb(), 0).length, 1, 'Sunday');
  assert.equal(seriesDue(pb(), 1).length, 0);
});

const net = (o: Partial<NetworkCtx> = {}): NetworkCtx => ({
  orchestrator: { id: 'o1', handle: 'kira' } as any, anchorKey: '@space', groupId: 'g1', groupName: 'Космос', mode: 'independent',
  resources: RES, playbook: pb(), playbookVersion: 1, telegramFormats: TG_FORMATS, ...o,
});
const idea = (id: string, variants: string[]): IdeaRow => ({
  id, agentId: 'o1', title: `Ідея ${id}`, angle: null, sources: ['https://x'], variants: variants.map((r) => ({ resource_ref: r, format: r.startsWith('telegram') ? 'longread' : r.startsWith('instagram') ? 'ig_carousel' : 'th_text' })),
  why: null, evidence: null, origin: 'orchestrator', originRef: null, expiresAt: new Date(), status: 'accepted', revisions: 0, review: null, createdAt: new Date(), updatedAt: new Date(),
});
const card = { channelKey: '@space', timezone: 'Europe/Kyiv', quietStartHour: 23, quietEndHour: 8, minGapMinutes: 60 };
const NOW = new Date('2026-10-04T05:00:00Z'); // Sunday 08:00 Kyiv
const I1 = '00000000-0000-4000-8000-000000000001';

test('network plan: a staggered idea + the Sunday series pass', () => {
  const v = validateNetworkPlan({
    rationale: 'Космічна неділя', slots: [
      { resource_ref: 'telegram:@space', time: '10:00', format: 'longread', topic: 'Кільця Сатурна', idea_id: I1, source_hints: [], reason: 'Ядро мережі: лонгріди дають перегляди' },
      { resource_ref: 'instagram:ig1', time: '12:00', format: 'ig_carousel', topic: 'Кільця Сатурна — карусель', idea_id: I1, source_hints: [], reason: 'Каруселі в IG — найкращий формат' },
      { resource_ref: 'threads:th1', time: '14:00', format: 'th_text', topic: 'Факт про кільця', idea_id: I1, source_hints: [], reason: 'Короткий факт для discovery' },
      { resource_ref: 'instagram:ig1', time: '18:30', format: 'ig_carousel', topic: 'Топ тижня', series: 'Топ тижня', source_hints: [] },
    ],
  }, { net: net(), card, planDate: '2026-10-04', weekday: 0, now: NOW, ideas: new Map([[I1, idea(I1, ['telegram:@space', 'instagram:ig1', 'threads:th1'])]]), reservedAt: [] });
  assert.equal(v.ok, true, JSON.stringify(v));
  if (v.ok) {
    assert.equal(v.slots.length, 4);
    assert.deepEqual(v.slots[3].sourceHints, ['series:Топ тижня']);
  }
});

test('network plan: violations come back as a list', () => {
  const v = validateNetworkPlan({
    rationale: 'Погано складений план', slots: [
      { resource_ref: 'instagram:ig1', time: '10:00', format: 'ig_carousel', topic: 'Кільця Сатурна', idea_id: I1, source_hints: [] },
      { resource_ref: 'telegram:@space', time: '11:00', format: 'longread', topic: 'Кільця Сатурна', idea_id: I1, source_hints: [] },
      { resource_ref: 'threads:th1', time: '23:30', format: 'ig_carousel', topic: 'Не той формат', source_hints: [] },
      { resource_ref: 'tiktok:x', time: '12:00', format: 'tt_photo', topic: 'Не в мережі', idea_id: I1, source_hints: [] },
      { resource_ref: 'instagram:ig1', time: '10:30', format: 'ig_carousel', topic: 'Серія не сьогодні', series: 'Нема такої', source_hints: [] },
    ],
  }, { net: net(), card, planDate: '2026-10-04', weekday: 1, now: NOW, ideas: new Map([[I1, idea(I1, ['telegram:@space', 'instagram:ig1'])]]), reservedAt: [] });
  assert.equal(v.ok, false);
  const e = (v as any).errors.join('\n');
  for (const frag of ['не дозволений плейбуком', 'тихі години', 'tiktok:x', 'не за розкладом', 'потрібен idea_id', 'потрібен reason', 'немає рішення для threads:th1']) {
    assert.ok(e.includes(frag), `${frag}\n${e}`);
  }
  // Spec 024: no "Telegram first" and no fixed gap between variants of one idea.
  assert.ok(!e.includes('першим') && !e.includes('90 хв'), e);
});

test('network plan: no playbook → refused', () => {
  const v = validateNetworkPlan({ rationale: 'без плейбука', slots: [] }, { net: net({ playbook: null }), card, planDate: '2026-10-04', weekday: 0, now: NOW, ideas: new Map(), reservedAt: [] });
  assert.equal(v.ok, false);
});

test('network plan: a planned idea needs one decision on every resource with a playbook section (spec 024)', () => {
  const tgOnly = { resource_ref: 'telegram:@space', time: '10:00', format: 'longread', topic: 'Кільця', idea_id: I1, source_hints: [], reason: 'Ядро мережі: лонгріди' };
  const v = validateNetworkPlan({ rationale: 'Лише Telegram', slots: [tgOnly] },
    { net: net(), card, planDate: '2026-10-04', weekday: 1, now: NOW, ideas: new Map([[I1, idea(I1, ['telegram:@space', 'instagram:ig1'])]]), reservedAt: [] });
  assert.equal(v.ok, false);
  const e = (v as any).errors.join('\n');
  assert.ok(e.includes('немає рішення для instagram:ig1') && e.includes('немає рішення для threads:th1'), e);
  // Skipping both with reasons is a complete decision set — the idea's variants are only hints.
  const ok = validateNetworkPlan({ rationale: 'Лише Telegram', slots: [tgOnly], skips: [
    { idea_id: I1, resource_ref: 'instagram:ig1', reason: 'Профіль IG — візуал, тут лише текст', reason_code: 'format_unfit' },
    { idea_id: I1, resource_ref: 'threads:th1', reason: 'Threads вже має схожу тему вчора', reason_code: 'cadence' },
  ] }, { net: net(), card, planDate: '2026-10-04', weekday: 1, now: NOW, ideas: new Map([[I1, idea(I1, ['telegram:@space', 'instagram:ig1'])]]), reservedAt: [] });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  if (ok.ok) assert.deepEqual(ok.decisions.map((d) => [d.resourceRef, d.decision, d.reasonCode]), [
    ['telegram:@space', 'unique', null], ['instagram:ig1', 'skip', 'format_unfit'], ['threads:th1', 'skip', 'cadence'],
  ]);
});
