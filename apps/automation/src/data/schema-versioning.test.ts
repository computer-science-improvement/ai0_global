import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSchemas } from './schema-versioning';
import type { FieldDef } from './data.types';

const base = {
  version: 3,
  fields: [
    { name: 'title', type: 'text', description: 'Name', required: true },
    { name: 'kind', type: 'enum', description: 'Kind', enum: ['a', 'b'] },
  ] as FieldDef[],
  roles: { title: 'title' },
  dedup_key: ['title'],
};

test('description-only edits keep the version', () => {
  const next = {
    ...base,
    title: 'New title',
    fields: base.fields.map((f) => ({ ...f, description: f.description + ' (edited)', agent_visible: false, filterable: true })),
  };
  const d = diffSchemas(base, next);
  assert.equal(d.structural, false);
  assert.equal(d.nextVersion, 3);
  assert.deepEqual(d.errors, []);
  assert.ok(d.changes.some((c) => c.kind === 'field_described' && c.field === 'title'));
});

test('a new field is structural and bumps the version; a required one without default is flagged', () => {
  const d = diffSchemas(base, { ...base, fields: [...base.fields, { name: 'year', type: 'int', description: '', required: true }] });
  assert.equal(d.structural, true);
  assert.equal(d.nextVersion, 4);
  assert.match(d.changes.find((c) => c.kind === 'field_added')!.detail!, /new version/);
});

test('deprecation, required change and roles change are structural', () => {
  assert.equal(diffSchemas(base, { ...base, fields: [base.fields[0], { ...base.fields[1], deprecated: true }] }).changes[0].kind, 'field_deprecated');
  assert.equal(diffSchemas(base, { ...base, fields: [{ ...base.fields[0], required: false }, base.fields[1]] }).structural, true);
  assert.equal(diffSchemas(base, { ...base, roles: { title: 'title', category: 'kind' } }).structural, true);
});

test('adding enum values is structural; removing them is an error', () => {
  const add = diffSchemas(base, { ...base, fields: [base.fields[0], { ...base.fields[1], enum: ['a', 'b', 'c'] }] });
  assert.equal(add.structural, true);
  assert.deepEqual(add.errors, []);
  const rm = diffSchemas(base, { ...base, fields: [base.fields[0], { ...base.fields[1], enum: ['a'] }] });
  assert.match(rm.errors[0], /only be added/);
});

test('removing, renaming or retyping a field is an error', () => {
  assert.match(diffSchemas(base, { ...base, fields: [base.fields[0]] }).errors[0], /cannot be removed or renamed/);
  assert.match(diffSchemas(base, { ...base, fields: [base.fields[0], { ...base.fields[1], name: 'kind2' }] }).errors[0], /"kind" cannot be removed/);
  assert.match(diffSchemas(base, { ...base, fields: [{ ...base.fields[0], type: 'long_text' }, base.fields[1]] }).errors[0], /cannot change/);
});

test('the dedup key cannot change once there are rows', () => {
  assert.deepEqual(diffSchemas(base, { ...base, dedup_key: ['title', 'kind'] }).errors, []);
  assert.match(diffSchemas(base, { ...base, dedup_key: ['title', 'kind'] }, { hasRows: true }).errors[0], /dedup_key/);
});

test('field order and since_version do not matter', () => {
  const next = { ...base, fields: [{ ...base.fields[1], since_version: 2 }, base.fields[0]] };
  assert.equal(diffSchemas(base, next).structural, false);
});
