import { readerQuestions, readerQuestionsIssue } from '../../audience-asks';
import { bodyText, excerptOf, type IntegrityCheck } from '../types';

/**
 * Spec 034 FR-005 adapter: questions to the readers over the resource cap (card.readerQuestionsMax, default 1) are
 * an error, as in lintPost. The poll's own question is the poll, so only the post text counts.
 */
export const readerQuestionsCheck: IntegrityCheck = {
  id: 'reader-questions',
  codes: ['reader_questions'],
  run: (post, ctx) => {
    const body = bodyText(post);
    const issue = readerQuestionsIssue(body, ctx.card?.readerQuestionsMax);
    return issue ? [{ code: issue.code, level: 'error' as const, message: issue.message, excerpt: excerptOf(readerQuestions(body)[0] ?? '') }] : [];
  },
};
