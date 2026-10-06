// Spec 023 T3: series v2 — cadence, sources, validation, ownership and the ≤ 90-min shift classification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPlaybookChange, Playbook, PlaybookSchema, SeriesSchema, seriesDue, validatePlaybook } from './playbook';
import { cadenceChange, formatCadence, instancesPerDay, parseCadence, seriesContent } from './series';
import { guardAgentSeries, isSeriesLocked, lockOwnerSeries, normalizePlaybook } from './series-edit';

const RES = [{ ref: 'telegram:@food', platform: 'telegram' as const }, { ref: 'instagram:ig1', platform: 'instagram' as const }];
const TG = ['text', 'photo', 'carousel'];
const v1Body = {
  platforms: [
    { resource_ref: 'telegram:@food', role: 'core', formats: { photo: 1, text: 0.5 }, per_day: { min: 1, max: 4 } },
    { resource_ref: 'instagram:ig1', role: 'discovery', formats: { ig_photo: 1 }, per_day: { min: 0, max: 2 } },
  ],
  series: [{ name: 'Рецепт дня', cadence: 'daily@19:00', resource_ref: 'telegram:@food', format: 'photo', brief: 'Рецепт з бібліотеки щовечора' }],
};
const pb = (series: Array<Record<string, unknown>> = v1Body.series): Playbook => PlaybookSchema.parse({ ...v1Body, series });

test('cadence v2: days and up to 6 times; v1 forms still parse', () => {
  assert.deepEqual(parseCadence('daily@19:00'), { days: null, times: ['19:00'] });
  assert.deepEqual(parseCadence('weekly:sun@10:00'), { days: [0], times: ['10:00'] });
  assert.deepEqual(parseCadence('weekly:thu,mon@20:30,09:00'), { days: [1, 4], times: ['09:00', '20:30'] });
  assert.equal(parseCadence('weekly:xyz@10:00'), null);
  assert.equal(parseCadence('daily@25:00'), null);
  assert.equal(formatCadence(parseCadence('weekly:thu,mon@20:30,09:00')!), 'weekly:mon,thu@09:00,20:30');
  assert.equal(instancesPerDay(parseCadence('weekly:mon,thu@09:00,20:30')!), 4 / 7);
  assert.equal(PlaybookSchema.safeParse({ ...v1Body, series: [{ ...v1Body.series[0], cadence: 'daily@08:00,09:00,10:00,11:00,12:00,13:00,14:00' }] }).success, false, '7 times > 6');
});

test('old bodies parse with v2 defaults and keep every v1 field', () => {
  const p = pb();
  assert.deepEqual(p.series[0], {
    name: 'Рецепт дня', cadence: 'daily@19:00', resource_ref: 'telegram:@food', format: 'photo', brief: 'Рецепт з бібліотеки щовечора',
    active: true, source_mode: 'suggested', origin: 'agent', locked: false,
  });
  assert.deepEqual(validatePlaybook(p, RES, TG), []);
  assert.deepEqual(normalizePlaybook(v1Body).series[0].origin, 'agent', 'stored raw bodies normalise the same way');
});

test('cadence change: same days and count → largest shift; days or count → structural', () => {
  assert.deepEqual(cadenceChange('daily@19:00', 'daily@19:00'), { same: true });
  assert.deepEqual(cadenceChange('daily@19:00', 'daily@20:00'), { shiftMinutes: 60 });
  assert.deepEqual(cadenceChange('weekly:mon,thu@09:00,19:00', 'weekly:mon,thu@09:30,20:30'), { shiftMinutes: 90 });
  assert.ok('structural' in cadenceChange('daily@19:00', 'weekly:mon@19:00'));
  assert.ok('structural' in cadenceChange('daily@19:00', 'daily@19:00,21:00'));
});

test('validation: series times in quiet hours, per-day instances over per_day.max, unknown sources', () => {
  const quiet = { startHour: 23, endHour: 8 };
  const p = pb([
    { ...v1Body.series[0], cadence: 'daily@07:30,19:00', source: { kind: 'library', table: 'recipes' } },
    { name: 'Нічний факт', cadence: 'daily@12:00,13:00,14:00', resource_ref: 'telegram:@food', format: 'text', brief: 'Факт дня з бібліотеки фактів', source: { kind: 'api', source: 'nope' } },
    { name: 'Зі стрічки', cadence: 'weekly:mon@12:00', resource_ref: 'instagram:ig1', format: 'ig_photo', brief: 'Новина з RSS-стрічки', source: { kind: 'feed', ref: 'https://unknown/rss' } },
  ]);
  const e = validatePlaybook(p, RES, TG, { quiet, sources: { tables: ['facts'], feeds: ['src1', 'https://feed/rss'] } }).join('\n');
  for (const frag of ['07:30 у тихі години', 'серій 5 на день > per_day.max 4', 'API nope немає', 'датасету recipes немає', 'фіду https://unknown/rss немає']) {
    assert.ok(e.includes(frag), `${frag}\n${e}`);
  }
  assert.deepEqual(validatePlaybook(pb(), RES, TG, { quiet, sources: { tables: ['recipes'], feeds: [] } }), []);
  // A paused series does not count against per_day.
  const paused = pb([{ ...v1Body.series[0], cadence: 'daily@10:00,12:00,14:00,16:00,18:00', active: false }]);
  assert.deepEqual(validatePlaybook(paused, RES, TG), []);
});

test('classification: a 60-min shift applies at once in shadow and live, needs the owner in approve; > 90 min always does', () => {
  const a = pb();
  const shifted = pb([{ ...v1Body.series[0], cadence: 'daily@20:00' }]);
  assert.equal(classifyPlaybookChange(a, shifted, { mode: 'live' }).structural, false);
  assert.equal(classifyPlaybookChange(a, shifted, { mode: 'shadow' }).structural, false);
  const appr = classifyPlaybookChange(a, shifted, { mode: 'approve' });
  assert.equal(appr.structural, true);
  assert.match(appr.reasons[0], /shift 60 min/);
  assert.equal(classifyPlaybookChange(a, shifted).structural, true, 'without a mode the shift stays structural');
  const far = pb([{ ...v1Body.series[0], cadence: 'daily@21:00' }]);
  assert.equal(classifyPlaybookChange(a, far, { mode: 'live' }).structural, true);
  const days = pb([{ ...v1Body.series[0], cadence: 'weekly:mon,tue,wed,thu,fri@19:00' }]);
  assert.match(classifyPlaybookChange(a, days, { mode: 'live' }).reasons.join(), /days changed/);
});

test('classification: source within its kind is minor; kind, mode, resource, format are structural; pause needs the owner only in approve', () => {
  const a = pb([{ ...v1Body.series[0], source: { kind: 'library', table: 'recipes' } }]);
  const sameKind = pb([{ ...v1Body.series[0], source: { kind: 'library', table: 'recipes', category: 'soup' } }]);
  assert.deepEqual(classifyPlaybookChange(a, sameKind, { mode: 'live' }), { structural: false, reasons: [] });
  const kind = pb([{ ...v1Body.series[0], source: { kind: 'api', source: 'nasa_apod', params: {} } }]);
  assert.match(classifyPlaybookChange(a, kind, { mode: 'live' }).reasons.join(), /source library → api/);
  const req = pb([{ ...v1Body.series[0], source: { kind: 'library', table: 'recipes' }, source_mode: 'required' }]);
  assert.match(classifyPlaybookChange(a, req, { mode: 'live' }).reasons.join(), /source mode/);
  const fmt = pb([{ ...v1Body.series[0], source: { kind: 'library', table: 'recipes' }, format: 'text' }]);
  assert.match(classifyPlaybookChange(a, fmt, { mode: 'live' }).reasons.join(), /format photo → text/);
  const paused = pb([{ ...v1Body.series[0], source: { kind: 'library', table: 'recipes' }, active: false }]);
  assert.equal(classifyPlaybookChange(a, paused, { mode: 'live' }).structural, false);
  assert.equal(classifyPlaybookChange(a, paused, { mode: 'approve' }).structural, true);
});

test('seriesDue: one instance per time on its days', () => {
  const p = pb([{ ...v1Body.series[0], cadence: 'weekly:mon,thu@09:00,20:30' }]);
  assert.deepEqual(seriesDue(p, 1).map((x) => x.time), ['09:00', '20:30']);
  assert.equal(seriesDue(p, 2).length, 0);
});

test('ownership: the owner locks what they create or edit; an agent cannot change, remove, claim or unlock it', () => {
  const agentPb = pb([v1Body.series[0], { name: 'Факт дня', cadence: 'daily@12:00', resource_ref: 'telegram:@food', format: 'text', brief: 'Короткий факт про їжу' }]);
  const ownerEdit = structuredClone(agentPb);
  ownerEdit.series[0].cadence = 'daily@20:30';
  ownerEdit.series.push(SeriesSchema.parse({ name: 'Неділя', cadence: 'weekly:sun@11:00', resource_ref: 'telegram:@food', format: 'text', brief: 'Недільне меню на тиждень' }));
  const locked = lockOwnerSeries(agentPb, ownerEdit);
  assert.deepEqual(locked.series.map((s) => [s.name, s.origin, s.locked]), [['Рецепт дня', 'agent', true], ['Факт дня', 'agent', false], ['Неділя', 'owner', true]]);
  assert.equal(isSeriesLocked(locked, 'Рецепт дня'), true);
  assert.equal(isSeriesLocked(locked, 'Факт дня'), false);
  // A later owner edit of something else keeps the lock (only Unlock hands it back).
  const again = lockOwnerSeries(locked, { ...locked, series: locked.series.map((s) => ({ ...s, locked: false })) });
  assert.equal(again.series[0].locked, true);

  const changed = structuredClone(locked);
  changed.series[0].cadence = 'daily@21:00';
  assert.equal((guardAgentSeries(locked, changed) as any).error, 'series_locked');
  const removed = { ...locked, series: locked.series.filter((s) => s.name !== 'Неділя') };
  assert.equal((guardAgentSeries(locked, removed) as any).error, 'series_locked');
  const claims = structuredClone(locked);
  claims.series[1] = { ...claims.series[1], origin: 'owner', locked: true, brief: 'Новий бриф факту дня' };
  claims.series.push({ ...claims.series[1], name: 'Своя', origin: 'migration', locked: true });
  const g = guardAgentSeries(locked, claims);
  assert.ok('body' in g);
  if ('body' in g) {
    assert.deepEqual(g.body.series.map((s) => [s.name, s.origin, s.locked]), [
      ['Рецепт дня', 'agent', true], ['Факт дня', 'agent', false], ['Неділя', 'owner', true], ['Своя', 'agent', false],
    ]);
  }
  assert.equal(seriesContent({ ...locked.series[0], locked: false }), seriesContent(locked.series[0]), 'the lock is not content');
});
