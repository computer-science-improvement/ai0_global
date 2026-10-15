import { SLOP_WARNING_CODES, slopWarnings } from '../../slop-lint';
import { bodyText, readerText, voiceOf, type IntegrityCheck } from '../types';

/**
 * Spec 034 FR-003 adapter: the slop counters (em dashes, exclamations, rhetorical Q&A, moral closer, adjective
 * triple, emoji / humour / slang over the resource prefs). Warnings, as in lintPost: the body is the author's text
 * without the rendered source and hashtag lines, `all` adds the poll.
 */
export const slopWarningsCheck: IntegrityCheck = {
  id: 'slop-warnings',
  codes: SLOP_WARNING_CODES,
  run: (post, ctx) => slopWarnings({ body: bodyText(post), all: readerText(post), prefs: voiceOf(ctx.card) })
    .map((w) => ({ code: w.code, level: 'warning' as const, message: w.message, excerpt: /«([^»]+)»/.exec(w.message)?.[1] })),
};
