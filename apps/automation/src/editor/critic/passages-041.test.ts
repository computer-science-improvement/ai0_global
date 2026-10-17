/** Spec 041 FR-006 (T6): passages for claims without numbers, lint false positives, overruled warnings. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimAnchors, PASSAGE, sourcePassages } from '../post/grounding';
import { adjectiveTriple } from '../post/slop-lint';
import { addressFindings } from '../post/style/style-rules';
import { overruledWarnings } from './overruled';

test('a quote or an attributed claim without numbers gets its own passage (by its Latin words and names)', () => {
  const post = 'Маск заявив, що Roadster стане найшвидшим серійним авто. Резервування вже відкрите.';
  assert.deepEqual(claimAnchors(post).map((c) => c.tokens.includes('roadster')), [true]);
  const filler = 'Lorem ipsum dolor sit amet. '.repeat(60);
  const page = `${filler} Elon Musk said the new Roadster will be the fastest production car ever made. ${filler}`;
  const ps = sourcePassages(post, [{ url: 'https://techcrunch.com/a', text: page }]);
  assert.equal(ps.length, 1);
  assert.match(ps[0].text, /fastest production car/);
  assert.ok(ps[0].about.some((a) => /^твердження: «Маск заявив/.test(a)), ps[0].about.join(' | '));
  // A sentence with numbers is anchored by its numbers, not twice.
  assert.deepEqual(claimAnchors('Маск заявив, що виробництво почнеться у 2028 році.'), []);
  assert.equal(PASSAGE.max, 8);
});

test('slop_adjective_triple skips lists of kinds; address_mixed skips «зазвичай»', () => {
  assert.equal(adjectiveTriple('переважно в математичних, логічних і символьних задачах'), null);
  assert.equal(adjectiveTriple('англійська, французька й німецька мови'), null);
  assert.equal(adjectiveTriple('яскравий, сміливий і неймовірний'), 'яскравий, сміливий і неймовірний');
  assert.deepEqual(addressFindings('Зазвичай ви отримаєте відповідь за годину. Перевірте пошту.', { address: 'vy' } as any), []);
  assert.deepEqual(addressFindings('Вкрай рідко, бодай раз на рік, ви це побачите.', { address: 'vy' } as any), []);
});

test('overruledWarnings: codes on passed posts, once per post, most frequent first', () => {
  const rows = [
    { critic: { verdict: 'pass', lint_warnings: ['number_not_in_sources', 'slop_em_dash', 'slop_em_dash'] } },
    { critic: { verdict: 'pass', lint_warnings: ['number_not_in_sources'] } },
    { critic: { verdict: 'revise', lint_warnings: ['slop_cliche'] } },
    { critic: null },
  ];
  assert.deepEqual(overruledWarnings(rows), [{ code: 'number_not_in_sources', posts: 2 }, { code: 'slop_em_dash', posts: 1 }]);
});
