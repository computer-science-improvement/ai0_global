import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_SAFE_FIX_KINDS, AUTO_SAFE_RUN_REPAIRS, DESTRUCTIVE_FIX_KINDS, FIX_ALL_EXCLUDED_KINDS, isAutoSafeFix, isDestructiveFix, isFixAllKind } from './auto-fix';
import { CONFIG_FAILURE_CODES, isConfigCode, isRepairable } from './slot-config';
import { FIX_KINDS } from '../sysadmin/audit.types';

/** Spec 072 FR-004: the closed list of fixes code may apply by itself. A test fails if it changes. */

test('exactly three kinds are auto-safe, and all are real fix kinds (spec 090 FR-005 added series_resume, guarded by pause_cause_gone)', () => {
  assert.deepEqual([...AUTO_SAFE_FIX_KINDS], ['tools_allow_add', 'hashtag_min_zero', 'series_resume']);
  for (const k of AUTO_SAFE_FIX_KINDS) assert.ok(FIX_KINDS.includes(k), k);
});

test('no other kind is auto-safe', () => {
  const others = FIX_KINDS.filter((k) => !(AUTO_SAFE_FIX_KINDS as readonly string[]).includes(k));
  assert.equal(others.length, FIX_KINDS.length - 3);
  for (const k of others) assert.equal(isAutoSafeFix(k), false, k);
  assert.equal(isAutoSafeFix('tools_allow_add'), true);
});

test('FIX_ALL_EXCLUDED_KINDS is bind_dataset, dataset_patch (075, W2) and source_drop (lead S9: destructive); every other kind is in Fix all', () => {
  assert.deepEqual([...FIX_ALL_EXCLUDED_KINDS], ['bind_dataset', 'dataset_patch', 'source_drop']);
  assert.equal(isFixAllKind('bind_dataset'), false);
  assert.equal(isFixAllKind('dataset_patch'), false);
  assert.equal(isFixAllKind('source_drop'), false, 'removing a source is one row at a time');
  assert.equal(isFixAllKind('host_proxy_add'), true, 'adding a host to the proxy list may run in Fix all');
  for (const k of FIX_KINDS.filter((x) => x !== 'source_drop')) assert.equal(isFixAllKind(k), true, k);
  assert.equal(isAutoSafeFix('source_drop'), false);
  assert.equal(isAutoSafeFix('host_proxy_add'), false, 'neither 076 fix is applied by code');
});

test('W1 integration review: source_drop is the one destructive kind (the row confirm is a danger Remove that names it)', () => {
  assert.deepEqual([...DESTRUCTIVE_FIX_KINDS], ['source_drop']);
  for (const k of FIX_KINDS) assert.equal(isDestructiveFix(k), k === 'source_drop', k);
  for (const k of DESTRUCTIVE_FIX_KINDS) assert.equal(isFixAllKind(k), false, `${k}: never in Fix all`);
});

test('lead I5: the runner\'s own slot repairs are a closed list of two, and isRepairable reads exactly that list', () => {
  assert.deepEqual([...AUTO_SAFE_RUN_REPAIRS], ['config_format_mismatch', 'config_source_mismatch']);
  for (const c of AUTO_SAFE_RUN_REPAIRS) {
    assert.equal(isRepairable(c), true, c);
    assert.ok(isConfigCode(c), `${c} is a config code`);
    assert.equal(isAutoSafeFix(c), false, `${c} is not a Fix kind`);
  }
  for (const c of CONFIG_FAILURE_CODES.filter((x) => !(AUTO_SAFE_RUN_REPAIRS as readonly string[]).includes(x))) assert.equal(isRepairable(c), false, c);
});
