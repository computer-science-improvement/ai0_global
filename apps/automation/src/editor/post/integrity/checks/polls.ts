import { assessPoll } from '../../polls/knowledge-poll';
import { localDayIndex, maxPollsInWindow } from '../../polls/poll-cap-guard';
import { DEFAULT_POLLS_PER_WEEK, isPollFormat } from '../../audience-asks';
import { POLL_WINDOW_DAYS } from '../../../roles/poll-cap';
import { excerptOf, type Finding, type IntegrityCheck } from '../types';

/**
 * Spec 037 FR-007 (T7): polls and quizzes (post/polls/knowledge-poll.ts).
 *   • `knowledge_poll` (warning, writer + critic): a knowledge question as a regular poll → `format: quiz` with
 *     `correct_index` and an `explanation` ≤ 200 chars. Opinion polls stay regular and are never flagged.
 *   • `quiz_answer_revealed` (error): the right answer is in the intro, the companion post or a post of the same story
 *     in the last 24 h; the reveal belongs in `explanation`. Before publishing lintPost passes the resource's last
 *     posts as `ctx.previous` (publish guard), so the companion and the story are seen there too.
 */
export const pollsCheck: IntegrityCheck = {
  id: 'polls',
  codes: ['knowledge_poll', 'quiz_answer_revealed'],
  run: (post, ctx) => {
    const a = assessPoll(post, ctx);
    if (!a) return [];
    const poll = post.poll!;
    const out: Finding[] = [];
    if (poll.kind === 'regular' && a.knowledge) {
      out.push({
        code: 'knowledge_poll', level: 'warning', excerpt: excerptOf(poll.question),
        message: a.why === 'answer_in_text'
          ? 'питання на знання: відповідь уже є в тексті поруч — зроби format: quiz з correct_index і explanation (≤ 200 символів)'
          : 'питання на знання (одна правильна відповідь серед назв чи чисел) — зроби format: quiz з correct_index і explanation (≤ 200 символів); звичайне опитування — лише на думку чи досвід',
      });
    }
    if (a.revealed) {
      out.push({
        code: 'quiz_answer_revealed', level: 'error', excerpt: excerptOf(poll.options[a.revealed.index]),
        message: `правильна відповідь «${excerptOf(poll.options[a.revealed.index], 60)}» уже є: ${a.revealed.where} — прибери її звідти, розкривай лише в explanation`,
      });
    }
    return out;
  },
};

/**
 * `poll_cap_reached` on a timeline (the export audit, the golden set): polls + quizzes over `polls_per_week` in any 7
 * local days, counting the earlier posts of `ctx.previous`. Before publishing the publish guard counts the real
 * published, waiting and approved posts (post/polls/poll-cap-guard.ts, `checkPublishGuards` and the chat), so lintPost
 * skips it.
 */
export const pollCapCheck: IntegrityCheck = {
  id: 'poll-cap',
  codes: ['poll_cap_reached'],
  run: (post, ctx) => {
    if (!post.poll && !(post.format && isPollFormat(post.format))) return [];
    const cap = ctx.card?.pollsPerWeek === undefined ? DEFAULT_POLLS_PER_WEEK : ctx.card.pollsPerWeek;
    if (cap === null) return [];
    const tz = post.timezone;
    const days = (ctx.previous ?? []).filter((p) => p.poll || (p.format && isPollFormat(p.format))).map((p) => localDayIndex(new Date(p.publishedAt), tz));
    const before = maxPollsInWindow(days, localDayIndex(new Date(post.publishedAt), tz));
    if (before + 1 <= cap) return [];
    return [{
      code: 'poll_cap_reached', level: 'error', excerpt: post.poll ? excerptOf(post.poll.question) : undefined,
      message: `опитувань і вікторин за ${POLL_WINDOW_DAYS} днів уже ${before} — ліміт ресурсу ${cap} на тиждень (polls_per_week)`,
    }];
  },
  lintEnforced: true,
};

export const POLL_CHECKS: IntegrityCheck[] = [pollsCheck, pollCapCheck];
