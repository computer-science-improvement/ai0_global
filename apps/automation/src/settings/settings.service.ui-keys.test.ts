// Spec 027 FR-004: `ui.*` rows in app_settings (the dashboard menu `ui.nav`) are
// UI state, not env overrides — GET /settings must not change when one exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SettingsService, isAiKey, isLandingKey, isUiKey } from './settings.service';
import { DEFAULT_MODEL_KEY } from '../editor/llm/model-defaults';

function poolWith(rows: Array<{ key: string; value: string }>) {
  const sqls: string[] = [];
  return {
    sqls,
    // Answers like Postgres would WITHOUT the WHERE filter, so the in-code filter is tested too.
    query: async (sql: string) => { sqls.push(sql); return { rows }; },
  };
}
const cfg = { get: (_k: string) => undefined } as any;

test('isUiKey', () => {
  assert.equal(isUiKey('ui.nav'), true);
  assert.equal(isUiKey('TRACKING_ENABLED'), false);
  assert.equal(isUiKey('uix'), false);
});

test('GET /settings is unchanged by a ui.nav row', async () => {
  const plain = new SettingsService(poolWith([{ key: 'TRACKING_ENABLED', value: 'true' }]) as any, cfg);
  const pool = poolWith([{ key: 'TRACKING_ENABLED', value: 'true' }, { key: 'ui.nav', value: '{"schemaVersion":1}' }]);
  const withUi = new SettingsService(pool as any, cfg);
  await Promise.all([plain.whenLoaded(), withUi.whenLoaded()]);
  assert.deepEqual(withUi.get(), plain.get());
  assert.deepEqual(withUi.get().overrides, ['TRACKING_ENABLED']);
  assert.match(pool.sqls[0], /WHERE key NOT LIKE 'ui\.%'/);
});

// Spec 026 FR-002: the landing settings (`landing.*`) belong to LandingConfigService.
test('GET /settings is unchanged by landing.* rows', async () => {
  assert.equal(isLandingKey('landing.ad_tg_username'), true);
  assert.equal(isLandingKey('landingx'), false);
  const plain = new SettingsService(poolWith([{ key: 'TRACKING_ENABLED', value: 'true' }]) as any, cfg);
  const pool = poolWith([{ key: 'TRACKING_ENABLED', value: 'true' }, { key: 'landing.ad_message_en', value: 'Hi {target} {ref}' }]);
  const withLanding = new SettingsService(pool as any, cfg);
  await Promise.all([plain.whenLoaded(), withLanding.whenLoaded()]);
  assert.deepEqual(withLanding.get(), plain.get());
  assert.match(pool.sqls[0], /NOT LIKE 'landing\.%'/);
});

// Spec 035: the global default model (`ai.default_model`) belongs to the Models page.
test('GET /settings is unchanged by ai.* rows (ai.default_model is never an env override)', async () => {
  assert.equal(DEFAULT_MODEL_KEY, 'ai.default_model');
  assert.equal(isAiKey(DEFAULT_MODEL_KEY), true);
  assert.equal(isAiKey('aix'), false);
  assert.equal(isAiKey('AI_KEY'), false);
  const plain = new SettingsService(poolWith([{ key: 'TRACKING_ENABLED', value: 'true' }]) as any, cfg);
  const pool = poolWith([{ key: 'TRACKING_ENABLED', value: 'true' }, { key: DEFAULT_MODEL_KEY, value: 'openai/gpt-5-mini' }]);
  const withAi = new SettingsService(pool as any, cfg);
  await Promise.all([plain.whenLoaded(), withAi.whenLoaded()]);
  assert.deepEqual(withAi.get(), plain.get());
  assert.deepEqual(withAi.get().overrides, ['TRACKING_ENABLED']);
  assert.match(pool.sqls[0], /NOT LIKE 'ai\.%'/);
});
