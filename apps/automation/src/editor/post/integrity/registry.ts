import type { AuditContext, AuditPost, Finding, IntegrityCheck } from './types';
import { slopPhrasesCheck } from './checks/slop-phrases';
import { bannedTermsCheck } from './checks/banned-terms';
import { slopWarningsCheck } from './checks/slop-warnings';
import { readerQuestionsCheck } from './checks/reader-questions';
import { datesCheck } from './checks/dates';
import { TEXT_HYGIENE_CHECKS } from './checks/text-hygiene';
import { styleChecks } from './checks/style';
import { varietyChecks } from './checks/variety';
import { storyCheck } from './checks/story';
import { SOURCE_CHECKS } from './checks/sources';

/**
 * Spec 037 FR-001: every deterministic integrity check, in report order. A new check (T2–T11) is one file under
 * `checks/` exporting an `IntegrityCheck` plus one line here; the golden set turns its labelled rows on by the
 * codes the check declares.
 */
export const INTEGRITY_CHECKS: IntegrityCheck[] = [
  // Spec 034 adapters (lintPost already enforces these before publishing).
  slopPhrasesCheck,
  bannedTermsCheck,
  slopWarningsCheck,
  readerQuestionsCheck,
  // Spec 037 checks go below, one line each: T2 stories, T4 sources, T5 dates, T6 hygiene, T7 polls, T8 style, T9 variety, T11 media.
  datesCheck,
  ...TEXT_HYGIENE_CHECKS,
  ...styleChecks,
  ...varietyChecks,
  storyCheck,
  ...SOURCE_CHECKS,
];

/** Every finding of every check on one post. A check that throws is reported as `check_failed`, never swallowed. */
export function runIntegrityChecks(post: AuditPost, ctx: AuditContext, checks: readonly IntegrityCheck[] = INTEGRITY_CHECKS): Finding[] {
  const out: Finding[] = [];
  for (const c of checks) {
    try {
      out.push(...c.run(post, ctx));
    } catch (e) {
      out.push({ code: 'check_failed', level: 'error', message: `${c.id}: ${(e as Error).message}` });
    }
  }
  return out;
}

/** The codes the registered checks can return (the golden set's "implemented" list). */
export function implementedCodes(checks: readonly IntegrityCheck[] = INTEGRITY_CHECKS): Set<string> {
  return new Set(checks.flatMap((c) => [...c.codes]));
}

/**
 * The context of each post of a timeline: earlier posts of the same channel (newest first) as `previous`, the
 * other channels' posts published before it (newest first) as `network`. Posts may come in any order and from
 * several channels; `base` adds the card / clock per post.
 */
export function timelineContexts(
  posts: readonly AuditPost[],
  base: (post: AuditPost) => Omit<AuditContext, 'previous' | 'network'> = () => ({}),
): Array<{ post: AuditPost; ctx: AuditContext }> {
  const at = (p: AuditPost) => Date.parse(p.publishedAt);
  const sorted = [...posts].sort((a, b) => at(a) - at(b) || a.id.localeCompare(b.id));
  return sorted.map((post, i) => {
    const before = sorted.slice(0, i).reverse();
    return {
      post,
      ctx: {
        ...base(post),
        previous: before.filter((p) => p.channel === post.channel),
        network: before.filter((p) => p.channel !== post.channel),
      },
    };
  });
}
