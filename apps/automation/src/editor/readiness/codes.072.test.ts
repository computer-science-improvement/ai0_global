import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOCTOR_CODES, DOCTOR_REASONS, doctorReason, LINK_PLACEHOLDERS, resolveLink } from './codes';
import { DOCTOR_CHECKS } from './checks';
import { REASONS, reasonFor } from '../reasons/catalogue';

/** Spec 072 FR-001: the doctor's reason codes, whose texts live in 073's one catalogue since the merge. */

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
  assert.ok(!(DOCTOR_CODES as readonly string[]).includes('source_unreachable'));
  assert.equal(reasonFor('source_unreachable')?.kind, 'skip', 'the catalogue keeps it as the skip reason it is');
  assert.ok(!emittedCodes().has('source_unreachable'), 'no check emits it');
  assert.ok(doctorReason('auto_fixed'));
  assert.ok(doctorReason('series_source_contradicted'));
});

test('lead S2 (073 × 072 merge): every doctor code is an entry of the one catalogue, of kind doctor (series_paused is the shared skip entry)', () => {
  const byCode = new Map(REASONS.map((e) => [e.code, e]));
  for (const code of DOCTOR_CODES) {
    const e = byCode.get(code);
    assert.ok(e, `${code} is in reasons/catalogue.ts`);
    assert.equal(e!.kind, code === 'series_paused' ? 'skip' : 'doctor', code);
  }
  assert.deepEqual(DOCTOR_REASONS.map((e) => e.code), [...DOCTOR_CODES]);
  assert.equal(new Set(REASONS.map((e) => e.code)).size, REASONS.length, 'one entry per code across both specs');
  // An entry with no fix or no link has a reason: auto_fixed is a record, bot_not_admin links to the launch itself.
  const bare = DOCTOR_REASONS.filter((e) => !e.fix || !e.link).map((e) => e.code).sort();
  assert.deepEqual(bare, ['auto_fixed', 'bot_not_admin']);
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

/** The codes the checks write as string literals (`code: 'x'`); the service's `auto_fixed` is the only catalogue entry no check emits. */
function emittedCodes(): Set<string> {
  const dir = join(__dirname, 'checks');
  const out = new Set<string>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
    for (const m of readFileSync(join(dir, name), 'utf8').matchAll(/\bcode:\s*'([a-z][a-z0-9_]*)'/g)) out.add(m[1]);
  }
  return out;
}

test('every code a check can emit is in the catalogue, and every catalogue code but auto_fixed is emitted by a check', () => {
  const emitted = emittedCodes();
  const known = new Set<string>(DOCTOR_CODES);
  assert.deepEqual([...emitted].filter((c) => !known.has(c)).sort(), [], 'a check emits a code that is not the doctor\'s');
  assert.deepEqual([...known].filter((c) => c !== 'auto_fixed' && !emitted.has(c)).sort(), [], 'a catalogue code no check emits');
  assert.ok(known.has('auto_fixed'), 'the service writes auto_fixed (A20)');
  assert.ok(!emitted.has('auto_fixed'));
});

test('all seven check files are in DOCTOR_CHECKS, once each', () => {
  assert.deepEqual(DOCTOR_CHECKS.map((c) => c.code), [
    'series_source_contradicted', 'series_source_not_required', 'material_exhausted', 'tools_missing_for_source', 'config_conflict', 'series_paused', 'bot_not_admin',
  ]);
});
