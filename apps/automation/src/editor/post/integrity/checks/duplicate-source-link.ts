import { canonicalUrl } from '../../source-link';
import { citedUrl } from './sources';
import type { IntegrityCheck } from '../types';

/**
 * Spec 063 FR-006: the same source URL as an inline anchor and as the rendered source (the `→ Source` line or a
 * «Джерело» button). A warning; before publishing the typography normaliser already turns the inline anchor into
 * plain text (`dropDuplicateSourceLink`), so this mostly flags published posts in the audit.
 */
export const duplicateSourceLinkCheck: IntegrityCheck = {
  id: 'duplicate-source-link',
  codes: ['duplicate_source_link'],
  run: (post) => {
    const url = citedUrl(post);
    if (!url) return [];
    const key = canonicalUrl(url);
    const inLinks = post.links.filter((l) => canonicalUrl(l.url) === key);
    const onButton = post.buttons.some((b) => b.url && canonicalUrl(b.url) === key);
    // The rendered source line is itself one of `links` (inline / footer style) or a button: a second occurrence is the duplicate.
    const duplicate = inLinks.length >= (onButton ? 1 : 2);
    if (!duplicate) return [];
    const anchor = inLinks[0];
    return [{
      code: 'duplicate_source_link', level: 'warning' as const, excerpt: anchor?.text.slice(0, 80) ?? url,
      message: `те саме посилання (${url}) стоїть і в тексті, і окремим рядком «→ Джерело» — залиш лише рядок джерела, а в тексті прибери посилання`,
    }];
  },
};
