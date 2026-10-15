import { findMixedScriptWords } from '../../text-hygiene';
import { readerText, type IntegrityCheck } from '../types';

/**
 * Spec 037 T6: Cyrillic and Latin letters in one word («Меркoff», 08.10) or hashtag (`#aiновини`, 13.10). A Latin
 * name with a Ukrainian ending after a hyphen («iPhone-ом») is fine. Look-alike Latin letters in an otherwise
 * Cyrillic word are fixed by the typography normaliser before lint, so before publishing this only sees real
 * mixes; the audit of published posts sees both.
 */
export const mixedScriptWordCheck: IntegrityCheck = {
  id: 'mixed-script-word',
  codes: ['mixed_script_word'],
  run: (post) => findMixedScriptWords(readerText(post)).map((w) => ({
    code: 'mixed_script_word', level: 'error' as const,
    message: w.hashtag
      ? 'хештег змішує латиницю й кирилицю — пиши його одним алфавітом'
      : w.kind === 'homoglyph'
        ? 'у кириличному слові латинські літери-двійники (o, a, e, i, c, p, x, y) — заміни їх кириличними'
        : 'слово змішує кирилицю й латиницю — пиши назву одним алфавітом: латиницею, як в оригіналі, або повністю кирилицею',
    excerpt: w.word,
  })),
};
