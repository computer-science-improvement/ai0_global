import type { EditorCard } from '../card';
import { POST_FORMATS } from '../post/post-spec';

export const CHAT_TIMEZONE = 'Europe/Kyiv';

/**
 * The card the chat validates and renders with when a channel has no editorial
 * card (spec 010): every format allowed, no hashtag vocabulary (lint then
 * accepts any well-formed hashtag), inline links, no mirrors. Scheduling for
 * such a channel stores exactly this card with mode 'off' (the planner ignores
 * 'off'), so a scheduled post is published with the rules it was drafted under.
 */
export function makeDefaultCard(channelKey: string, title: string | null): EditorCard {
  return {
    channelKey, mode: 'off', title, language: 'uk', timezone: CHAT_TIMEZONE,
    postsPerDayMin: 2, postsPerDayMax: 6, quietStartHour: 23, quietEndHour: 8, minGapMinutes: 60, planHour: 6,
    brief: '', formats: Object.fromEntries(POST_FORMATS.map((f) => [f, 1])),
    hashtags: [], hashtagMin: 0, hashtagMax: 5, footer: null, linkStyle: 'inline', emojiPolicy: 'sparse',
    skills: [], sources: [], toolsAllow: null, exploreRatio: 0.2, dailyBudgetUsd: null, models: {}, bannedTerms: [],
    crosspost: false,
  };
}
