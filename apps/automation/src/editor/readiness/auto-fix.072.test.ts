import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_SAFE_FIX_KINDS, FIX_ALL_EXCLUDED_KINDS, isAutoSafeFix, isFixAllKind } from './auto-fix';
import { FIX_KINDS } from '../sysadmin/audit.types';

/** Spec 072 FR-004: the closed list of fixes code may apply by itself. A test fails if it changes. */

test('exactly two kinds are auto-safe, and both are real fix kinds', () => {
  assert.deepEqual([...AUTO_SAFE_FIX_KINDS], ['tools_allow_add', 'hashtag_min_zero']);
  for (const k of AUTO_SAFE_FIX_KINDS) assert.ok(FIX_KINDS.includes(k), k);
});

test('no other kind is auto-safe', () => {
  const others = FIX_KINDS.filter((k) => !(AUTO_SAFE_FIX_KINDS as readonly string[]).includes(k));
  assert.equal(others.length, FIX_KINDS.length - 2);
  for (const k of others) assert.equal(isAutoSafeFix(k), false, k);
  assert.equal(isAutoSafeFix('tools_allow_add'), true);
});

test('FIX_ALL_EXCLUDED_KINDS is bind_dataset and dataset_patch (075 adds the kinds in W2); every current kind is in Fix all', () => {
  assert.deepEqual([...FIX_ALL_EXCLUDED_KINDS], ['bind_dataset', 'dataset_patch']);
  assert.equal(isFixAllKind('bind_dataset'), false);
  assert.equal(isFixAllKind('dataset_patch'), false);
  for (const k of FIX_KINDS) assert.equal(isFixAllKind(k), true, k);
});
