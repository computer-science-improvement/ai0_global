import type { EditorCard } from '../card';
import { POST_FORMATS } from '../post/post-spec';

export const CHAT_TIMEZONE = 'Europe/Kyiv';

/**
 * Formats a new card starts with (spec 034 FR-005/FR-007): text and photo. Polls, quizzes,
 * carousels, longreads and the rest are added on purpose (the owner, or the playbook build
 * with a reason); a poll or quiz is weight 0 unless the owner asks or the resource is a
 * quiz/education resource.
 */
export const DEFAULT_CARD_FORMATS: Readonly<Record<string, number>> = { text: 1, photo: 1 };

/**
 * The card of a new resource (agent creation, tests): text and photo only, no hashtag
 * vocabulary (lint then accepts any well-formed hashtag), inline links, no mirrors.
 */
export function makeDefaultCard(channelKey: string, title: string | null): EditorCard {
  return {
    channelKey, mode: 'off', title, language: 'uk', timezone: CHAT_TIMEZONE,
    postsPerDayMin: 2, postsPerDayMax: 6, quietStartHour: 23, quietEndHour: 8, minGapMinutes: 60, planHour: 6,
    brief: '', formats: { ...DEFAULT_CARD_FORMATS },
    hashtags: [], hashtagMin: 0, hashtagMax: 5, footer: null, linkStyle: 'inline', emojiPolicy: 'sparse',
    skills: [], sources: [], toolsAllow: null, exploreRatio: 0.2, dailyBudgetUsd: null, models: {}, bannedTerms: [],
    crosspost: false,
  };
}

/**
 * The card the owner's chat validates and renders with when a channel has no editorial
 * card (spec 010): the default card with every format allowed, because the owner asks
 * for the format himself («додай опитування»). Scheduling for such a channel stores
 * exactly this card with mode 'off' (the planner ignores 'off'), so a scheduled post is
 * published with the rules it was drafted under.
 */
export function makeChatCard(channelKey: string, title: string | null): EditorCard {
  return { ...makeDefaultCard(channelKey, title), formats: Object.fromEntries(POST_FORMATS.map((f) => [f, 1])) };
}
