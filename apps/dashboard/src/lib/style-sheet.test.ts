import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptProposal, glossaryPairs, proposalSummary, styleSummary, toStyle, toStyleForm } from './style-sheet';
import { formatValue } from './format-prefs';
import type { StyleProposal, StyleSheet, StyleView } from '../api/agents';

const DEFAULTS: StyleSheet = { address: 'vy', glossary: { prefer: { API_uk: 'API', CLI_uk: 'CLI' } }, hashtags: 'off', content_kind: 'news' };
const view = (stored: StyleSheet): StyleView => ({ stored, effective: { ...DEFAULTS, ...stored }, defaulted: [], kind: 'news' });

test('style sheet: form round trip keeps every stored field', () => {
  const stored: StyleSheet = {
    address: 'ty', glossary: { prefer: { Spotifai: 'Spotify' }, ban: ['Razom AI'] }, names: 'original', headline: { max_chars: 120 },
    numbers: { decimal: 'comma' }, units: 'words', hashtags: 'vocabulary', audience: { level: 'beginner' }, content_kind: 'games', freshness_hours: 48,
  };
  assert.deepEqual(toStyle(toStyleForm(view(stored), undefined)), stored);
  assert.deepEqual(toStyle(toStyleForm(undefined, stored)), stored, 'an older server: the stored prefs');
});

test('style sheet: nothing set stays unset — the defaults (and the default glossary) stay the server’s', () => {
  const f = toStyleForm(view({}), undefined);
  assert.equal(f.glossaryOwn, false);
  assert.deepEqual(f.prefer, [{ insteadOf: 'API_uk', use: 'API' }, { insteadOf: 'CLI_uk', use: 'CLI' }], 'the form shows the default glossary');
  assert.equal(toStyle(f), undefined);
  assert.deepEqual(toStyle({ ...f, hashtags: 'off' }), { hashtags: 'off' });
  // Editing the glossary makes it the owner's: empty pairs are dropped.
  assert.deepEqual(toStyle({ ...f, glossaryOwn: true, prefer: [...f.prefer, { insteadOf: ' ', use: '' }], ban: ['Razom AI'] }),
    { glossary: { prefer: { API_uk: 'API', CLI_uk: 'CLI' }, ban: ['Razom AI'] } });
  assert.deepEqual(toStyle({ ...f, glossaryOwn: true, prefer: [], ban: [] }), { glossary: {} }, 'an emptied glossary turns the defaults off');
});

test('style sheet: glossary pairs from either stored shape', () => {
  assert.deepEqual(glossaryPairs([{ instead_of: 'Spotifai', use: 'Spotify' }]), [{ insteadOf: 'Spotifai', use: 'Spotify' }]);
  assert.deepEqual(glossaryPairs({ Spotifai: 'Spotify' }), [{ insteadOf: 'Spotifai', use: 'Spotify' }]);
  assert.deepEqual(glossaryPairs(undefined), []);
});

test('style sheet: one-line summary for the Formatting row', () => {
  assert.equal(styleSummary(DEFAULTS), 'Formal "vy" · no hashtags · glossary 2 · News');
  assert.equal(styleSummary({ names: 'original', units: 'words', headline: { max_chars: 90 }, audience: { level: 'expert' } }),
    'names: original · headline ≤ 90 · units in words · expert readers');
  assert.equal(styleSummary(undefined), 'Defaults');
  assert.equal(formatValue('style', { hashtags: 'vocabulary' }), 'hashtag vocabulary');
});

test('style sheet: the proposal fills the form only when accepted', () => {
  const p: StyleProposal = {
    ref: 'telegram:@games', days: 60, posts: 40,
    names: { latin: 9, cyrillic: 2, examples: { latin: ['Mark Gurman'], cyrillic: [] }, propose: 'original' },
    hashtags: { groups: [], propose: ['games', 'giveaway'] }, propose: { names: 'original', vocabulary: ['games', 'giveaway'] },
  };
  const f = toStyleForm(view({}), undefined);
  assert.equal(acceptProposal(f, p).names, 'original');
  assert.equal(f.names, '', 'nothing changes before accepting');
  assert.equal(proposalSummary(p), 'From 40 posts of the last 60 days: names in the original script (9 original vs 2 transliterated uses); a hashtag vocabulary of 2.');
  assert.equal(proposalSummary({ ...p, propose: {} }), '');
  assert.equal(acceptProposal(f, { ...p, propose: {} }), f);
});
