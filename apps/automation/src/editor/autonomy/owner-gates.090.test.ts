/**
 * Spec 090 FR-001: the owner-gate registry is pinned. A change here is a reviewed decision about what owner silence does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OWNER_GATES, HUMAN_ONLY_GATES, gateFor, gateHours, ownerSilenceMode, pendingActionGate, silenceApplies, silenceFor,
} from './owner-gates';
import { DIRECTIVE_KINDS } from '../manager/directives.repository';
import { SETTINGS } from '../../settings/catalog';

const env = (m: Record<string, string> = {}) => (k: string) => m[k];

test('registry pin: every key and what silence does', () => {
  const pinned = Object.fromEntries(OWNER_GATES.map((g) => [g.key, g.onSilence]));
  assert.deepEqual(pinned, {
    'series_pause:no_material': 'apply',
    'series_pause:source_unreachable': 'apply',
    'series_pause:owner': 'wait',
    'directive:frequency': 'apply',
    'directive:format_mix': 'apply',
    'directive:format_shift': 'apply',
    'directive:voice_fix': 'apply',
    'directive:task': 'apply',
    'directive:pause_series': 'apply',
    'directive:experiment': 'apply',
    'directive:advice': 'apply',
    'directive:cross_promo': 'drop',
    'directive:strategy': 'drop',
    'directive:pause_resource': 'drop',
    'directive:repost': 'drop',
    directive_contest: 'drop',
    'pending_action:change_source': 'apply',
    'pending_action:edit_data_schema': 'apply',
    'pending_action:chat': 'drop',
    'pending_action:*': 'drop',
    playbook: 'apply',
    'playbook:structural': 'wait',
    setup_proposal: 'apply',
    'audit_fix:memory_retire': 'apply',
    'audit_fix:tools_allow_add': 'apply',
    'audit_fix:hashtag_min_zero': 'apply',
    'audit_fix:series_resume': 'apply',
    'audit_fix:series_source_require': 'apply',
    'audit_fix:skill_inline_off': 'apply',
    'audit_fix:conflicts_resolve': 'wait',
    'audit_fix:skill_disable': 'wait',
    'audit_fix:source_drop': 'wait',
    'audit_fix:host_proxy_add': 'wait',
    'readiness_fix:series_resume': 'apply',
    launch_graduation: 'apply',
    slo_recovery: 'apply',
    credential: 'wait',
    bot_admin: 'wait',
    budget_raise: 'wait',
    mode_switch: 'wait',
    post_approval: 'wait',
    launch_start: 'wait',
    cross_promo: 'wait',
    network_mode: 'wait',
    strategy_migration: 'wait',
    steering_set: 'wait',
    network_offer: 'wait',
  });
});

test('human-only gates never apply and are flagged', () => {
  const flagged = OWNER_GATES.filter((g) => g.humanOnly).map((g) => g.key).sort();
  assert.deepEqual(flagged, [...HUMAN_ONLY_GATES].sort());
  for (const k of HUMAN_ONLY_GATES) assert.equal(silenceFor(k, env()), 'wait');
});

test('every apply gate is reversible (spec 091 slo_recovery is the one logged, irreversible exception); keys are unique', () => {
  for (const g of OWNER_GATES) if (g.onSilence === 'apply') assert.equal(g.reversible, g.key !== 'slo_recovery', g.key);
  assert.equal(new Set(OWNER_GATES.map((g) => g.key)).size, OWNER_GATES.length);
});

test('every directive kind has a gate', () => {
  for (const k of DIRECTIVE_KINDS) assert.ok(gateFor(`directive:${k}`).key === `directive:${k}`, k);
});

test('OWNER_SILENCE=wait maps apply back to the pre-090 behaviour', () => {
  assert.equal(ownerSilenceMode(env()), 'act');
  assert.equal(ownerSilenceMode(env({ OWNER_SILENCE: 'WAIT ' })), 'wait');
  assert.equal(ownerSilenceMode(env({ OWNER_SILENCE: 'nonsense' })), 'act');
  const wait = env({ OWNER_SILENCE: 'wait' });
  assert.equal(silenceFor('directive:frequency', wait), 'drop');
  assert.equal(silenceFor('pending_action:change_source', wait), 'drop');
  assert.equal(silenceFor('playbook', wait), 'wait');
  assert.equal(silenceFor('audit_fix:memory_retire', wait), 'wait');
  assert.equal(silenceFor('setup_proposal', wait), 'drop');
  for (const g of OWNER_GATES) if (g.onSilence !== 'apply') assert.equal(silenceFor(g.key, wait), g.onSilence, g.key);
});

test('fallbacks and unknown keys', () => {
  assert.equal(gateFor('pending_action:repurpose').key, 'pending_action:*');
  assert.equal(silenceFor('pending_action:set_network_mode', env()), 'drop');
  assert.throws(() => gateFor('nope'), /unknown owner gate/);
  assert.throws(() => gateFor('nope:x'), /unknown owner gate/);
  assert.equal(pendingActionGate({ kind: 'change_source', chatId: 'c1' }), 'pending_action:chat');
  assert.equal(pendingActionGate({ kind: 'change_source', chatId: null }), 'pending_action:change_source');
});

test('timeouts: setting, default, 0 = never, event-driven gates', () => {
  assert.equal(gateHours('directive:task', env()), 12);
  assert.equal(gateHours('directive:task', env({ DIRECTIVE_TIMEOUT_HOURS: '3' })), 3);
  assert.equal(gateHours('playbook', env()), 48);
  assert.equal(gateHours('readiness_fix:series_resume', env()), null);
  const t0 = new Date('2026-11-07T00:00:00Z');
  const at = (h: number) => new Date(t0.getTime() + h * 3_600_000);
  assert.equal(silenceApplies('playbook', env(), t0, at(47.9)), false);
  assert.equal(silenceApplies('playbook', env(), t0, at(48)), true);
  assert.equal(silenceApplies('playbook', env({ PLAYBOOK_PENDING_HOURS: '0' }), t0, at(1000)), false);
  assert.equal(silenceApplies('playbook', env({ OWNER_SILENCE: 'wait' }), t0, at(1000)), false);
  assert.equal(silenceApplies('directive:strategy', env(), t0, at(1000)), false);
  assert.equal(silenceApplies('readiness_fix:series_resume', env(), t0, t0), true);
});

test('every timeout setting named by a gate is in the settings catalog', () => {
  const keys = new Set(SETTINGS.map((s) => s.key));
  for (const g of OWNER_GATES) if (g.hoursSetting) assert.ok(keys.has(g.hoursSetting), `${g.key} → ${g.hoursSetting}`);
  assert.ok(keys.has('OWNER_SILENCE'));
  const def = (k: string) => SETTINGS.find((s) => s.key === k)?.default;
  assert.equal(def('DIRECTIVE_TIMEOUT_APPLY_KINDS'), 'frequency,format_mix,format_shift,voice_fix,task,pause_series,experiment,advice');
  assert.equal(def('LAUNCH_GRADUATION'), 'auto');
  assert.equal(def('OWNER_SILENCE'), 'act');
});
