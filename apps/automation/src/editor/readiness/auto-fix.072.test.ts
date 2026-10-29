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

test('FIX_ALL_EXCLUDED_KINDS is empty in this wave (075 adds bind_dataset and dataset_patch)', () => {
  assert.deepEqual([...FIX_ALL_EXCLUDED_KINDS], []);
  assert.equal(isFixAllKind('series_resume'), true);
});
