import { analogyOpener } from '../../slop-lint';
import { monotonyFindings } from '../../variety/monotony';
import { jargonOverLevel, LEVEL_UK } from '../../variety/jargon';
import { bodyText, excerptOf, type IntegrityCheck } from '../types';

/**
 * Spec 037 FR-009 (T9): monotony against the resource's last 20 posts (`ctx.previous`; without history nothing is
 * found) — `monotony_opening`, `monotony_phrase`, `monotony_format_topic`. Warnings for the critic.
 */
export const monotonyCheck: IntegrityCheck = {
  id: 'monotony',
  codes: ['monotony_opening', 'monotony_phrase', 'monotony_format_topic'],
  run: (post, ctx) => monotonyFindings(post, ctx.previous ?? []),
};

/**
 * Spec 037 FR-009 (T9): `jargon_over_level` (warning) — more unexplained terms than the audience level allows
 * (`style.audience.level`; without it the check is silent).
 */
export const jargonCheck: IntegrityCheck = {
  id: 'jargon',
  codes: ['jargon_over_level'],
  run: (post, ctx) => {
    const text = [bodyText(post), post.poll?.question ?? '', ...(post.poll?.options ?? [])].filter(Boolean).join('\n');
    const over = jargonOverLevel(text, ctx.card?.style?.audience?.level);
    if (!over) return [];
    return [{
      code: 'jargon_over_level', level: 'warning' as const,
      message: `${over.terms.length} термінів без пояснення для аудиторії «${LEVEL_UK[over.level]}» (можна ${over.budget}) — поясни простими словами (у дужках, через «— це» чи наступним реченням) або прибери`,
      excerpt: excerptOf(over.terms.join(', '), 120),
    }];
  },
};

/** Spec 063 FR-007: how many of the channel's last posts are looked at, and how many with the opener make it a template. */
export const ANALOGY_WINDOW = 5;
export const ANALOGY_MIN = 2;

/**
 * Spec 063 FR-007 (`slop_analogy_opener`, warning): the post opens with an analogy («X — це як Y», «Уявіть, що…») and
 * ≥ 2 of the resource's last 5 posts did too — review 3: one analogy opener served every explainer. Needs the history
 * (`ctx.previous`, newest first); without it nothing is found.
 */
export const analogyOpenerCheck: IntegrityCheck = {
  id: 'analogy-opener',
  codes: ['slop_analogy_opener'],
  run: (post, ctx) => {
    const opener = analogyOpener(bodyText(post));
    if (!opener) return [];
    const used = (ctx.previous ?? []).slice(0, ANALOGY_WINDOW).filter((p) => analogyOpener(bodyText(p))).length;
    if (used < ANALOGY_MIN) return [];
    return [{
      code: 'slop_analogy_opener', level: 'warning' as const, excerpt: excerptOf(opener, 80),
      message: `пост відкривається аналогією («${opener}…»), як ${used} із ${Math.min(ANALOGY_WINDOW, ctx.previous.length)} останніх постів каналу — почни з факту чи прикладу`,
    }];
  },
};

/** Spec 037 T9: the variety checks, registered as one group. */
export const varietyChecks: IntegrityCheck[] = [monotonyCheck, jargonCheck, analogyOpenerCheck];
