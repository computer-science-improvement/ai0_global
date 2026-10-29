import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOCTOR_REASONS, doctorReason, LINK_PLACEHOLDERS, resolveLink } from './codes';

/** Spec 072 FR-001: the doctor's reason catalogue. */

test('codes are unique, snake_case and have a known kind', () => {
  const codes = DOCTOR_REASONS.map((r) => r.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const r of DOCTOR_REASONS) {
    assert.match(r.code, /^[a-z][a-z0-9_]*$/, r.code);
    assert.ok(['skip', 'preflight', 'config', 'doctor', 'source', 'dataset'].includes(r.kind), r.code);
  }
  assert.ok(DOCTOR_REASONS.length >= 19);
});

test('English texts have no Cyrillic; Ukrainian texts are not empty and are Cyrillic', () => {
  const CYR = /[Ѐ-ӿ]/;
  for (const r of DOCTOR_REASONS) {
    assert.ok(r.en.trim().length > 0, r.code);
    assert.ok(!CYR.test(r.en), `${r.code}: Cyrillic in en`);
    assert.ok(r.uk.trim().length > 0, r.code);
    assert.match(r.uk, CYR, `${r.code}: uk has no Ukrainian`);
    if (r.fix) {
      assert.ok(r.fix.en.trim() && r.fix.uk.trim(), `${r.code}: empty fix text`);
      assert.ok(!CYR.test(r.fix.en), `${r.code}: Cyrillic in fix.en`);
      assert.match(r.fix.uk, CYR, `${r.code}: fix.uk`);
    }
  }
});

test('link placeholders are known, and every link is a dashboard path', () => {
  for (const r of DOCTOR_REASONS) {
    if (!r.link) continue;
    assert.ok(r.link.startsWith('/app/'), `${r.code}: ${r.link}`);
    for (const m of r.link.matchAll(/:([a-z]+)/g)) assert.ok((LINK_PLACEHOLDERS as readonly string[]).includes(m[1]), `${r.code}: :${m[1]}`);
  }
});

test('source_unreachable is a skip class and a pause cause, never a doctor code', () => {
  assert.equal(doctorReason('source_unreachable'), undefined);
  assert.ok(doctorReason('auto_fixed'));
  assert.ok(doctorReason('series_source_contradicted'));
});

test('every reason that offers a fix says what to change in one sentence', () => {
  for (const r of DOCTOR_REASONS) {
    if (!r.fix) continue;
    assert.ok(r.fix.en.length <= 200, r.code);
    assert.equal(r.fix.en.split(/[.!?]\s/).length, 1, `${r.code}: more than one sentence`);
  }
});

test('resolveLink fills and URL-encodes placeholders; a missing value gives null', () => {
  assert.equal(resolveLink('/app/agents/:agent?tab=skills', { agent: 'a b' }), '/app/agents/a%20b?tab=skills');
  assert.equal(resolveLink('/app/editor/:channel', { channel: '@my chan' }), '/app/editor/%40my%20chan');
  assert.equal(resolveLink('/app/data/:dataset', { dataset: 'tips' }), '/app/data/tips');
  assert.equal(resolveLink('/app/agents/:agent?tab=skills', {}), null);
  assert.equal(resolveLink('/app/agents/:agent', { agent: '' }), null);
  assert.equal(resolveLink('/app/agents/:agent', { agent: null }), null);
  assert.equal(resolveLink(undefined, { agent: 'x' }), null);
  assert.equal(resolveLink('/app/health', {}), '/app/health');
});
