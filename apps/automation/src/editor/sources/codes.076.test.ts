import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { SOURCE_REASONS, sourceReason, type ReasonEntry } from './codes';
import { reasonFor } from '../reasons/catalogue';
import { SOURCE_FINDING_CODES, sourceFindings } from './source-findings';
import { HOST_STRUCK_KIND } from './source-health.service';
import { resyncFailedNote } from '../docs/list-resync.worker';

/** Spec 076 FR-008 / L4 / A31 / L10: the catalogue entries of the source codes, and the isolation of the sources folder. */

const CYRILLIC = /[Ѐ-ӿ]/;
const DOCTOR = ['source_probe_failed', 'source_empty', 'source_untested', 'card_without_sources', 'dataset_resync_manual'];

test('the seven codes, once each, in snake_case', () => {
  assert.deepEqual(SOURCE_REASONS.map((r) => r.code), [...DOCTOR, 'host_struck', 'resync_failed']);
  assert.equal(new Set(SOURCE_REASONS.map((r) => r.code)).size, SOURCE_REASONS.length, 'unique');
  for (const r of SOURCE_REASONS) assert.match(r.code, /^[a-z][a-z0-9_]*$/, r.code);
});

test('the English text and the English fix have no Cyrillic; the Ukrainian text and fix are not empty', () => {
  for (const r of SOURCE_REASONS) {
    assert.ok(r.en.trim(), `${r.code}: en`);
    assert.doesNotMatch(r.en, CYRILLIC, `${r.code}: en`);
    assert.ok(r.uk.trim(), `${r.code}: uk`);
    assert.match(r.uk, CYRILLIC, `${r.code}: uk is Ukrainian`);
    assert.ok(r.fix, `${r.code}: a fix sentence`);
    assert.ok(r.fix.en.trim() && r.fix.uk.trim(), `${r.code}: both fix texts`);
    assert.doesNotMatch(r.fix.en, CYRILLIC, `${r.code}: fix.en`);
  }
});

test('the kinds of L4: the five finding codes are doctor entries, the two note codes are source entries', () => {
  for (const c of DOCTOR) assert.equal(sourceReason(c)?.kind, 'doctor', c);
  for (const c of ['host_struck', 'resync_failed']) assert.equal(sourceReason(c)?.kind, 'source', c);
  assert.deepEqual([...SOURCE_FINDING_CODES], DOCTOR, 'the checks emit exactly the doctor codes');
});

test('source_unreachable is a skip class and a pause cause, never a code here; host_unreachable is a tool error code, not the note\'s', () => {
  const codes = SOURCE_REASONS.map((r) => r.code);
  assert.ok(!codes.includes('source_unreachable'));
  assert.ok(!codes.includes('host_unreachable'));
  assert.equal(sourceReason('source_unreachable'), undefined);
});

test('the note codes are the notes\' own Inbox kinds', () => {
  assert.equal(sourceReason(HOST_STRUCK_KIND)?.code, 'host_struck');
  assert.equal(sourceReason(resyncFailedNote('d', 'x', undefined).kind)?.code, 'resync_failed');
});

test('links are dashboard paths with the contract\'s placeholders only', () => {
  for (const r of SOURCE_REASONS) {
    assert.ok(r.link?.startsWith('/app/'), r.code);
    for (const p of r.link!.match(/:[a-z]+/g) ?? []) assert.ok([':channel', ':agent', ':dataset', ':series'].includes(p), `${r.code}: ${p}`);
  }
  assert.equal(sourceReason('dataset_resync_manual')?.link, '/app/data/:dataset');
  assert.equal(sourceReason('resync_failed')?.link, '/app/data/:dataset');
  assert.equal(sourceReason('host_struck')?.link, '/app/agents/:agent?tab=settings');
});

test('sourceReason: the entry of a code, undefined for any other', () => {
  const e: ReasonEntry | undefined = sourceReason('source_empty');
  assert.equal(e?.en, 'The source is empty or not a feed');
  assert.equal(sourceReason('nope'), undefined);
  assert.equal(sourceReason(''), undefined);
});

test('what the checks say is English, whatever they are asked about', () => {
  const NOW = new Date('2026-10-29T12:00:00Z');
  const out = sourceFindings({
    channelKey: '@chan', agent: 'chan_agent', now: NOW, createdAt: NOW, proxyConfigured: true, uploadedImports: ['pdr_rules'],
    sources: [
      { url: 'https://a.example/feed', kind: 'rss', origin: 'card', host: 'a.example', id: 'a', hostBlock: { reason: 'unreachable', until: NOW.toISOString(), strikes: 1 } },
      { url: 'https://b.example/page', kind: 'url', origin: 'card', host: 'b.example', hostBlock: null, id: 'b' },
    ],
  });
  assert.deepEqual(out.map((f) => f.check), ['source_probe_failed', 'source_untested', 'dataset_resync_manual']);
  for (const f of out) assert.doesNotMatch(JSON.stringify([f.title, f.detail, f.link]), CYRILLIC, f.check);
});

test('after the lead merge (S8): only codes.ts imports the reasons catalogue, and nothing in sources imports the readiness code', () => {
  const files = readdirSync(__dirname, { recursive: true } as any) as string[];
  const sources = files.filter((f) => f.endsWith('.ts') && !/\.test\.ts$/.test(f));
  assert.ok(sources.length > 10, 'the folder was read');
  const importing = (dir: string) => sources.filter((f) => new RegExp(`from\\s+['"][^'"]*\\/${dir}(\\/|['"])`).test(readFileSync(join(__dirname, f), 'utf8')));
  assert.deepEqual(importing('readiness'), [], 'the doctor wraps sourceFindings, not the reverse');
  assert.deepEqual(importing('reasons'), ['codes.ts']);
});

test('the seven entries are the catalogue\'s own (S8): one source of truth, the same objects', () => {
  for (const r of SOURCE_REASONS) assert.equal(reasonFor(r.code), r, r.code);
  assert.equal(reasonFor('source_unreachable')?.kind, 'skip', 'the skip class stays a catalogue skip entry');
});
