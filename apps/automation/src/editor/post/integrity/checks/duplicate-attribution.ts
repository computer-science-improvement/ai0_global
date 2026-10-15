import { sentencesOf } from '../../slop-lint';
import { attributionOf, sourceNames } from '../../text-hygiene';
import { bodyText, excerptOf, type AuditPost, type IntegrityCheck } from '../types';

/** The source the code renders (the `→ Source` line or a «Джерело» button) and the names it goes by; null when none. */
function renderedSource(post: AuditPost): string[] | null {
  if (post.sourceUrl) {
    const label = post.links.find((l) => l.url === post.sourceUrl)?.text ?? null;
    return sourceNames(post.sourceUrl, label);
  }
  const button = post.buttons.find((b) => b.url && /^джерело/iu.test(b.text.trim()));
  return button ? sourceNames(button.url, button.text.replace(/^джерело\s*:?\s*/iu, '')) : null;
}

/**
 * Spec 037 T6: «Джерело: X» / «За даними X» closing a paragraph while the code renders the same source as the
 * `→ X` line or a button (09.10, both AI channels). Before publishing the typography normaliser drops a trailing
 * attribution line of the spec, so this is mostly for the audit of published posts: a warning.
 */
export const duplicateAttributionCheck: IntegrityCheck = {
  id: 'duplicate-attribution',
  codes: ['duplicate_attribution'],
  run: (post) => {
    const names = renderedSource(post);
    if (!names?.length) return [];
    const hit = bodyText(post).split('\n').map((line) => sentencesOf(line).at(-1) ?? '').map((s) => attributionOf(s, names)).find(Boolean);
    return hit ? [{
      code: 'duplicate_attribution', level: 'warning' as const,
      message: 'джерело вже стоїть окремим рядком або кнопкою під постом — прибери «Джерело: …» з тексту',
      excerpt: excerptOf(hit),
    }] : [];
  },
};
