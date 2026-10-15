import { brokenCharText, findBrokenChars } from '../../text-hygiene';
import { readerText, type IntegrityCheck } from '../types';

/**
 * Spec 037 T6: broken characters anywhere the reader reads (text, poll, buttons) — U+FFFD («пе��еважно», 11.10),
 * control characters, zero-width characters inside a word, mojibake. Always an error: the word is unreadable.
 */
export const textReplacementCharCheck: IntegrityCheck = {
  id: 'text-replacement-char',
  codes: ['text_replacement_char'],
  run: (post) => findBrokenChars([readerText(post), ...post.buttons.map((b) => b.text)].join('\n')).map((b) => ({
    code: 'text_replacement_char', level: 'error' as const,
    message: `${brokenCharText(b.kind)}: перепиши це слово звичайними літерами`,
    excerpt: b.excerpt,
  })),
};
