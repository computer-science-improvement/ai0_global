// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { charCount, configPatch, draftFromConfig, previewDraft } from './landing-config-draft';
import type { LandingAdminConfig } from '../api/landing';

const DEFAULT = "Hi! I'd like to order an ad in {target}. {ref}";
const cfg = (s: Partial<LandingAdminConfig['settings']> = {}): LandingAdminConfig => ({
  settings: { adTgUsername: null, adMessage: null, whiteLabelEnabled: true, ...s },
  defaults: { adMessage: DEFAULT },
  resolved: { username: null, source: null },
  agentSessionUsername: null,
});

test('a fresh draft shows the effective values', () => {
  assert.deepEqual(draftFromConfig(cfg()), { username: '', message: DEFAULT, whiteLabelEnabled: true });
  assert.deepEqual(draftFromConfig(cfg({ adTgUsername: 'ads_desk', adMessage: 'Hi {ref}', whiteLabelEnabled: false })),
    { username: 'ads_desk', message: 'Hi {ref}', whiteLabelEnabled: false });
});

test('an untouched draft is not dirty', () => {
  const c = cfg({ adTgUsername: 'ads_desk' });
  assert.deepEqual(configPatch(c, draftFromConfig(c)), {});
  assert.deepEqual(configPatch(c, { ...draftFromConfig(c), username: ' @ads_desk ' }), {}, 'the @ and spaces are not a change');
});

test('changes produce a minimal patch; empty and default values clear keys', () => {
  const c = cfg({ adTgUsername: 'ads_desk', adMessage: 'Custom {target} {ref}' });
  const d = draftFromConfig(c);
  assert.deepEqual(configPatch(c, { ...d, username: '@new_desk' }), { adTgUsername: 'new_desk' });
  assert.deepEqual(configPatch(c, { ...d, username: '' }), { adTgUsername: null });
  assert.deepEqual(configPatch(c, { ...d, message: DEFAULT }), { adMessage: null });
  assert.deepEqual(configPatch(c, { ...d, message: '  ' }), { adMessage: null });
  assert.deepEqual(configPatch(c, { ...d, message: 'Other {target}' }), { adMessage: 'Other {target}' });
  assert.deepEqual(configPatch(c, { ...d, whiteLabelEnabled: false }), { whiteLabelEnabled: false });
  // Clearing a message that is already the default is no change.
  assert.deepEqual(configPatch(cfg(), { ...draftFromConfig(cfg()), message: '' }), {});
});

test('the preview body and character count', () => {
  assert.deepEqual(previewDraft({ username: ' @x_desk ', message: 'Hi', whiteLabelEnabled: true }), { adTgUsername: 'x_desk', adMessage: 'Hi' });
  assert.equal(charCount('🚀ab'), 3);
});
