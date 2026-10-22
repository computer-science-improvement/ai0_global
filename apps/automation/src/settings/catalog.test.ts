/** Spec 039 FR-001: the settings catalog. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INFRA_KEYS, SETTINGS, SETTING_GROUPS, normalizeSetting, settingDef } from './catalog';

test('every key is unique, an env name, in a known group, and never an infrastructure key', () => {
  const keys = SETTINGS.map((d) => d.key);
  assert.equal(new Set(keys).size, keys.length);
  const groups = new Set(SETTING_GROUPS.map((g) => g.id));
  for (const d of SETTINGS) {
    assert.match(d.key, /^[A-Z][A-Z0-9_]+$/, d.key);
    assert.ok(groups.has(d.group), d.key);
    assert.ok(!INFRA_KEYS.includes(d.key), `${d.key} must stay in env`);
    assert.ok(d.label && d.help, d.key);
    assert.ok(!/[а-яіїєґ]/i.test(d.label + d.help), `${d.key}: UI text is English`);
  }
});

test('every default passes its own validation (bools: their on / off value)', () => {
  for (const d of SETTINGS) {
    if (d.default === '') continue;
    const r = normalizeSetting(d, d.default);
    assert.ok('value' in r && r.value === d.default, `${d.key}: ${JSON.stringify(r)}`);
    if (d.type === 'bool') assert.ok(d.bool && [d.bool.on, d.bool.off].includes(d.default), d.key);
  }
});

test('templated families are expanded: retention windows, role models and efforts', () => {
  for (const k of ['AI_LOGS_RETENTION_DAYS', 'EDITOR_RUNS_RETENTION_DAYS', 'LANDING_LEAD_PURGE_DAYS', 'EDITOR_MODEL_MANAGER',
    'EDITOR_ANTHROPIC_MODEL_CHECKER', 'EDITOR_REASONING_PLANNER', 'INSTAGRAM_COOLDOWN_MIN']) assert.ok(settingDef(k), k);
  assert.equal(settingDef('EDITOR_RUNS_RETENTION_DAYS')!.default, '180');
  assert.equal(settingDef('EDITOR_RUNS_RETENTION_DAYS')!.min, 0, 'the retention job skips a 0-day window (keep forever)');
  assert.match(settingDef('EDITOR_RUNS_RETENTION_DAYS')!.help, /0 = keep forever/);
});

test('normalizeSetting: types, bounds and shapes', () => {
  const v = (k: string, x: unknown) => normalizeSetting(settingDef(k)!, x);
  assert.deepEqual(v('EDITOR_ENABLED', true), { value: 'true' });
  assert.deepEqual(v('EDITOR_CRITIC', false), { value: 'off' }, 'an on/off switch takes a boolean');
  assert.deepEqual(v('EDITOR_CRITIC', 'on'), { value: 'on' });
  assert.ok('error' in v('EDITOR_CRITIC', 'maybe'));
  assert.deepEqual(v('POSTING_COOLDOWN_MIN', ' 25 '), { value: '25' });
  assert.ok('error' in v('POSTING_COOLDOWN_MIN', '0'));
  assert.ok('error' in v('POSTING_COOLDOWN_MIN', '2.5'));
  assert.deepEqual(v('TRACKING_VIEW_TO_SUB_RATE', '0.05'), { value: '0.05' });
  assert.ok('error' in v('TRACKING_VIEW_TO_SUB_RATE', '2'));
  assert.deepEqual(v('TIKTOK_PRIVACY_LEVEL', 'PUBLIC_TO_EVERYONE'), { value: 'PUBLIC_TO_EVERYONE' });
  assert.ok('error' in v('TIKTOK_PRIVACY_LEVEL', 'public'));
  assert.deepEqual(v('DIRECTIVE_TIMEOUT_APPLY_KINDS', 'advice, task,advice'), { value: 'advice,task' });
  assert.ok('error' in v('DIRECTIVE_TIMEOUT_APPLY_KINDS', 'advice,nope'));
  assert.deepEqual(v('DASHBOARD_URL', 'https://ai0.example/'), { value: 'https://ai0.example/' });
  assert.ok('error' in v('DASHBOARD_URL', 'ftp://x'));
  assert.ok('error' in v('DASHBOARD_URL', 'not a url'));
  assert.deepEqual(v('AGENT_POLL_CRON', '*/10  * * * *'), { value: '*/10 * * * *' });
  assert.ok('error' in v('AGENT_POLL_CRON', 'every 5 minutes'));
  assert.deepEqual(v('OPENROUTER_API_KEY', 'sk-or-v1-abc'), { value: 'sk-or-v1-abc' });
  assert.ok('error' in v('OPENROUTER_API_KEY', 'two words'));
  assert.deepEqual(v('TELEGRAM_OWNER_ID', '123456789'), { value: '123456789' });
  assert.ok('error' in v('TELEGRAM_OWNER_ID', '@owner'));
  assert.ok('error' in v('META_GRAPH_VERSION', '21'));
  assert.ok('error' in v('POSTING_COOLDOWN_MIN', ''), 'empty is a reset, not a value');
  assert.ok('error' in v('SUPABASE_CAROUSEL_BUCKET', 'a\nb'));
  assert.equal(settingDef('LEDGER_REUSABLE_HOSTS')!.default, 'zakon.rada.gov.ua');
  assert.deepEqual(v('LEDGER_REUSABLE_HOSTS', 'zakon.rada.gov.ua, iso.org'), { value: 'zakon.rada.gov.ua,iso.org' });
  assert.ok('error' in v('LEDGER_REUSABLE_HOSTS', 'https://zakon.rada.gov.ua/'), 'a host, not a URL');
});
