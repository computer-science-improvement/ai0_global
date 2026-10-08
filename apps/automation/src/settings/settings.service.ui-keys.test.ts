// Spec 027 FR-004: `ui.*` rows in app_settings (the dashboard menu `ui.nav`) are
// UI state, not env overrides — GET /settings must not change when one exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SettingsService, isLandingKey, isUiKey } from './settings.service';

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
