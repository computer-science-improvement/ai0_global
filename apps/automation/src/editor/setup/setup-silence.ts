import type { SetupSection } from './setup-analysis';
import { SETUP_SECTIONS } from './setup-analysis';

/**
 * Spec 090 FR-007: the sections of a setup proposal that code applies when the owner stays silent for
 * SETUP_PROPOSAL_APPLY_HOURS. A closed list, pinned by a test: adding a section here is a reviewed decision.
 *
 * Safe means the section only changes how the channel sounds, not what it posts or how much:
 *  - `formatting`     tone, length, emoji, hashtag policy, CTA and the other format preferences, the card's hashtags / footer /
 *                     emoji policy / link style. Fields the owner locked are kept by `formatPatch` as always.
 *  - `examples_voice` the good example posts copied from the channel's history and the channel-voice skill.
 *
 * Left for the owner (they expire at SETUP_PROPOSAL_TTL_DAYS as before):
 *  - `brief_profile`   rewrites the channel brief and the profile (topic, audience, language, goals) and can rebuild the playbook.
 *  - `format_mix`      changes what formats the channel posts.
 *  - `series_pillars`  adds series and topic pillars.
 *  - `schedule`        changes the posting rate and the quiet hours together with the best hours; the rate is not a "within the
 *                      card's range" change.
 */
export const SETUP_SAFE_SECTIONS = ['formatting', 'examples_voice'] as const satisfies readonly SetupSection[];
export type SetupSafeSection = typeof SETUP_SAFE_SECTIONS[number];

export const isSafeSetupSection = (s: string): s is SetupSafeSection => (SETUP_SAFE_SECTIONS as readonly string[]).includes(s);

/** The sections of the proposal that are not safe (they keep waiting for the owner). */
export const SETUP_OWNER_SECTIONS: readonly SetupSection[] = SETUP_SECTIONS.filter((s) => !isSafeSetupSection(s));

/** Prefix of `reason` once an apply on silence failed: the sweep does not try that proposal again (the owner can still apply it by hand). */
export const SILENCE_FAILED_PREFIX = 'silence apply failed';
