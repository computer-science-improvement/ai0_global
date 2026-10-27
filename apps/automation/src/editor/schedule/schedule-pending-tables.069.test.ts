import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaybookSchema } from '../network/playbook';
import { isFail, ScheduleService, type ScheduleScope } from './schedule.service';

/**
 * Spec 069 FR-002: `prepareSeriesChange` knows the datasets the same card still creates. An `import_list` bundle imports the
 * dataset first and binds the series to it after, so the bind is checked now against a dataset that does not exist yet.
 */

const TG = 'telegram:@food';
const BODY = PlaybookSchema.parse({
  platforms: [{ resource_ref: TG, role: 'core', formats: { photo: 1, text: 0.5 }, per_day: { min: 1, max: 4 } }],
  series: [{ name: 'Prompt of the day', cadence: 'daily@19:00', resource_ref: TG, format: 'photo', brief: 'A prompt with its picture each evening' }],
});

const scope = (): ScheduleScope => ({
  agent: { id: 'a-1', handle: 'ai_global' } as any,
  card: { channelKey: '@food' } as any,
  net: { playbook: BODY, playbookVersion: 3, resources: [{ ref: TG, platform: 'telegram' }], telegramFormats: ['photo', 'text', 'quiz'] } as any,
});

const service = (catalog: { tables: string[]; feeds?: string[]; entities?: Record<string, string> }) =>
  new ScheduleService({ sourceCatalog: async () => ({ feeds: [], ...catalog }) } as any);

const FIELDS = (table: string) => ({ name: 'Prompt of the day', source: { kind: 'library', table }, source_mode: 'required' });

test('a dataset that does not exist yet is refused, unless the same card creates it', async () => {
  const svc = service({ tables: ['recipes'] });
  const plain = await svc.prepareSeriesChange(scope(), 'update', FIELDS('nanobanana_prompts'));
  assert.ok(isFail(plain));
  assert.equal(plain.error, 'series_invalid');
  assert.match(String(plain.details), /no dataset nanobanana_prompts in the library|датасету nanobanana_prompts немає/);

  const ok = await svc.prepareSeriesChange(scope(), 'update', FIELDS('nanobanana_prompts'), { pendingTables: ['nanobanana_prompts'], pendingEntities: { nanobanana_prompts: 'entry' } });
  assert.ok(!isFail(ok), JSON.stringify(ok));
  assert.match(ok.diff, /library:nanobanana_prompts/);
  assert.match(ok.diff, /required/);
  assert.equal(ok.fields.source_mode, 'required');
  assert.deepEqual(ok.fields.source, { kind: 'library', table: 'nanobanana_prompts' });
});

test('a pending dataset does not make another unknown dataset valid', async () => {
  const svc = service({ tables: [] });
  const r = await svc.prepareSeriesChange(scope(), 'update', FIELDS('other_table'), { pendingTables: ['nanobanana_prompts'] });
  assert.ok(isFail(r));
});

test('the format of the new dataset is checked against the series format now, not at Apply', async () => {
  const svc = service({ tables: [] });
  const r = await svc.prepareSeriesChange(scope(), 'update', FIELDS('quiz_bank'), { pendingTables: ['quiz_bank'], pendingEntities: { quiz_bank: 'quiz_question' } });
  assert.ok(isFail(r));
  assert.match(JSON.stringify(r.details), /quiz/);
});

test('a dataset the library already has keeps its entity (the card is not about to replace it)', async () => {
  const svc = service({ tables: ['quiz_bank'], entities: { quiz_bank: 'entry' } });
  const r = await svc.prepareSeriesChange(scope(), 'update', FIELDS('quiz_bank'), { pendingTables: ['quiz_bank'], pendingEntities: { quiz_bank: 'quiz_question' } });
  assert.ok(!isFail(r), JSON.stringify(r));
});

test('an unknown series is an error at propose time', async () => {
  const svc = service({ tables: [] });
  const r = await svc.prepareSeriesChange(scope(), 'update', { ...FIELDS('nb'), name: 'No such series' }, { pendingTables: ['nb'] });
  assert.ok(isFail(r));
  assert.equal(r.error, 'series_not_found');
});
