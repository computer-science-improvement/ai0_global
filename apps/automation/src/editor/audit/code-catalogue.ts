import { INTEGRITY_CODES } from '../post/integrity/codes';

/**
 * Spec 037 FR-014 (T14): what every integrity code means for the owner and how to fix it, in English (the dashboard
 * shows it next to the post: Network health → "Notes and sample posts", the approval card). One entry per code of
 * `integrity/codes.ts` (a test keeps them in step), plus `check_failed`. The check's own message stays in the
 * agents' language and is not shown in the UI.
 *
 * `group` is the MANAGER digest flag a code counts towards (by the task that owns it: T2 stories → `story_repeat`,
 * T4 facts → `fact_conflict`, T5 → `date_issue`, T6 → `text_hygiene`, T8 → `style_violation`), `section` the block
 * of the approval card. A code a later task adds without an entry still gets both from its task, and a generic text.
 */

export const AUDIT_FLAGS = ['story_repeat', 'fact_conflict', 'date_issue', 'text_hygiene', 'style_violation'] as const;
export type AuditFlag = typeof AUDIT_FLAGS[number];

export type FindingSection = 'stories' | 'facts' | 'dates' | 'lint';

export interface CodeExplanation {
  /** Short English name of the rule. */
  title:   string;
  /** What the rule found, in one or two sentences. */
  explain: string;
  /** How to fix the post (or the setting behind it). */
  fix:     string;
}

export interface CodeCatalogueEntry extends CodeExplanation {
  code:    string;
  task:    string;
  group:   AuditFlag | null;
  section: FindingSection;
}

const GROUP_OF_TASK: Record<string, AuditFlag> = {
  T2: 'story_repeat', T4: 'fact_conflict', T5: 'date_issue', T6: 'text_hygiene', T8: 'style_violation',
};
const SECTION_OF_TASK: Record<string, FindingSection> = { T2: 'stories', T3: 'stories', T4: 'facts', T5: 'dates' };

export const CODE_EXPLANATIONS: Record<string, CodeExplanation> = {
  // Spec 034 voice rules (lintPost enforces them before publishing).
  banned_term: {
    title: 'Banned phrase',
    explain: 'The post uses a listed AI cliche or a term the owner banned for this resource.',
    fix: 'Rewrite the sentence in plain words; edit the banned terms on the resource profile if the ban is wrong.',
  },
  reader_questions: {
    title: 'Too many questions to readers',
    explain: 'The post asks the readers more questions than the resource allows (news resources: none).',
    fix: 'Keep at most the allowed number of questions, or turn the question into a statement.',
  },
  slop_em_dash: {
    title: 'Too many em dashes',
    explain: 'More long dashes than one per 400 characters reads as an AI rhythm.',
    fix: 'Replace most dashes with a full stop, a comma or a colon.',
  },
  slop_exclamation: {
    title: 'Too many exclamation marks',
    explain: 'More than one exclamation mark in a post sounds like advertising.',
    fix: 'Keep one exclamation mark at most; let the facts carry the tone.',
  },
  slop_rhetorical_qa: {
    title: 'Rhetorical question and answer',
    explain: 'The post asks a question and answers it itself, a typical AI pattern.',
    fix: 'State the point directly without the set-up question.',
  },
  slop_moral_closer: {
    title: 'Moral at the end',
    explain: 'The post ends with a lesson or summary sentence ("the moral is...").',
    fix: 'End on the last fact or a concrete detail; drop the closing moral.',
  },
  slop_adjective_triple: {
    title: 'Triple adjectives',
    explain: 'Three adjectives in a row ("fast, simple and powerful") read as filler.',
    fix: 'Keep the one adjective that matters, or replace them with a fact.',
  },
  slop_emoji_over_pref: {
    title: 'Too many emoji',
    explain: 'The post has more emoji than the resource emoji setting allows.',
    fix: 'Remove emoji down to the setting, or change the emoji setting on the resource.',
  },
  slop_humor_off: {
    title: 'Jokes on a serious resource',
    explain: 'The post jokes although humour is off for this resource.',
    fix: 'Remove the joke, or turn humour on in the resource voice settings.',
  },
  slop_slang_off: {
    title: 'Slang on a formal resource',
    explain: 'The post uses slang although slang is off for this resource.',
    fix: 'Use neutral words, or allow slang in the resource voice settings.',
  },
  // T2 story registry.
  story_repeat: {
    title: 'Same story again',
    explain: 'The post retells a story the resource already covered in the last 14 days, without being a follow-up.',
    fix: 'Skip the item, or publish it as a follow-up (a reply to the original) with a fact that is new.',
  },
  followup_without_new_facts: {
    title: 'Follow-up without new facts',
    explain: 'The post is marked as a follow-up but brings nothing that the original post did not already say.',
    fix: 'Add the new fact the follow-up is about, or skip it.',
  },
  followup_restates: {
    title: 'Follow-up repeats the original',
    explain: 'More than half of the follow-up restates the original post.',
    fix: 'Lead with the new fact and link the original instead of retelling it.',
  },
  story_cross_channel: {
    title: 'Sibling channel posted it',
    explain: 'Another channel of the network published this story in the last 24 hours.',
    fix: 'Choose deliberately: skip, write an angle of your own, or repost the sibling post.',
  },
  // T3 announcement → recap.
  event_not_covered: {
    title: 'Announced event not covered',
    explain: 'An event the resource announced has passed and no recap went out within 24 hours.',
    fix: 'Publish a short recap of what happened, or note why it is not covered.',
  },
  event_date_missing: {
    title: 'Announcement without its date',
    explain: 'The post announces an event (story.event_at) but its text does not say when the event is.',
    fix: 'Write the event date (and time, Kyiv) in the text, the same as declared in story.event_at.',
  },
  // T4 facts and sources.
  number_not_in_sources: {
    title: 'Number without a source',
    explain: 'A number in the post was not found in the pages the agent read.',
    fix: 'Check the number against the source and correct it, or remove it.',
  },
  fact_conflict: {
    title: 'Fact contradicts an earlier post',
    explain: 'A fact (price, name, date, count) differs from an earlier post about the same story.',
    fix: 'Find which version is right, correct the post and, if the earlier one was wrong, publish a correction.',
  },
  source_is_homepage: {
    title: 'Source is a homepage',
    explain: 'The source link points at a site root or a section index, not at the article.',
    fix: 'Link the exact article the post is based on.',
  },
  low_tier_claim: {
    title: 'Numbers from a weak source',
    explain: 'Specific numbers come from a low-quality source (a "fun facts" page, an aggregator).',
    fix: 'Take the number from the primary source, or drop it.',
  },
  source_aggregator: {
    title: 'Aggregator instead of the primary source',
    explain: 'The source is an aggregator (MarkTechPost, GamerPower) whose page links the original.',
    fix: 'Open the linked original (blog, paper, store page) and cite it instead.',
  },
  // T5 dates and freshness.
  date_relative_mismatch: {
    title: 'Relative date is wrong',
    explain: 'A word like "tomorrow" or "today" and the explicit date disagree with the publish date.',
    fix: 'Recompute the date from the publish time in the resource time zone, or write the date only.',
  },
  weekday_mismatch: {
    title: 'Weekday does not match the date',
    explain: 'The weekday named in the post is not the weekday of the date next to it.',
    fix: 'Correct the weekday or the date.',
  },
  relative_date_unanchored: {
    title: 'Relative date without a date',
    explain: 'A news post says "tomorrow" or "from tomorrow" without the explicit date.',
    fix: 'Add the date ("tomorrow, 16 October") so the post stays right when read later.',
  },
  stale_now_word: {
    title: '"Just now" about old news',
    explain: 'The post says "just" or "right now" about something older than 24 hours.',
    fix: 'Drop the freshness word or give the real date.',
  },
  deal_expired: {
    title: 'Deal already over',
    explain: 'A giveaway or deal ends before (or at) the publish time.',
    fix: 'Do not publish an expired deal; pick a current one.',
  },
  deal_expiring: {
    title: 'Deal ends very soon',
    explain: 'A giveaway or deal ends less than 6 hours after the publish time.',
    fix: 'Say clearly when it ends, or skip it if readers cannot use it in time.',
  },
  stale_source: {
    title: 'Old source',
    explain: 'The source is older than the freshness limit (news 36 hours, games 72 hours).',
    fix: 'Use a fresher item, or give the post a reason why it matters now.',
  },
  // T6 text hygiene.
  text_replacement_char: {
    title: 'Broken characters',
    explain: 'The text contains a replacement character, control or zero-width characters, or mojibake.',
    fix: 'Retype the affected words; check the source text the post was copied from.',
  },
  mixed_script_word: {
    title: 'Mixed alphabets in a word',
    explain: 'A word or hashtag mixes Latin and Cyrillic letters that look alike.',
    fix: 'Retype the word in one alphabet.',
  },
  process_leak: {
    title: 'Agent talks about its work',
    explain: 'A sentence describes the agent\'s own process ("no promo codes were found, so...").',
    fix: 'Remove the sentence; readers only need the result.',
  },
  duplicate_attribution: {
    title: 'Source named twice',
    explain: 'The text names the source although the code already renders the source line under the post.',
    fix: 'Remove the "Source: ..." line from the text.',
  },
  lead_too_long: {
    title: 'Headline too long',
    explain: 'The bold first line is longer than 140 characters (over 220 is an error).',
    fix: 'Shorten the headline to one short sentence; move details into the body.',
  },
  decimal_mixed: {
    title: 'Mixed decimal separators',
    explain: 'The post uses both a comma and a dot as the decimal separator.',
    fix: 'Use one separator throughout (the resource style sets which).',
  },
  verbatim_repeat: {
    title: 'Repeated phrase in the post',
    explain: 'The same sequence of four or more words appears twice in one post.',
    fix: 'Rephrase or remove the second occurrence.',
  },
  slop_cliche: {
    title: 'Cliche phrase',
    explain: 'The post uses a soft cliche ("this is the case when", a sentence starting with "in short").',
    fix: 'Say the point directly without the stock phrase.',
  },
  // T7 polls and quizzes.
  knowledge_poll: {
    title: 'Knowledge question as a poll',
    explain: 'A question with one right answer was posted as a regular poll.',
    fix: 'Use a quiz with the correct option and a short explanation.',
  },
  quiz_answer_revealed: {
    title: 'Quiz answer given away',
    explain: 'The right answer is in the intro, the companion post or a post of the same story from the last 24 hours.',
    fix: 'Remove the answer from the intro and the posts around the quiz; reveal it only in the quiz explanation.',
  },
  poll_cap_reached: {
    title: 'Too many polls',
    explain: 'Polls and quizzes this week are over the resource cap.',
    fix: 'Use another format, or raise the poll cap on the resource profile.',
  },
  // T8 resource style sheet.
  address_mixed: {
    title: 'Inconsistent form of address',
    explain: 'The post mixes the informal and the formal "you", or uses a form other than the resource style.',
    fix: 'Address the readers in the resource form throughout (formal "you" by default).',
  },
  glossary_violation: {
    title: 'Glossary term',
    explain: 'The post uses a banned transliteration or a translated brand name from the resource glossary.',
    fix: 'Use the preferred spelling from the glossary (for example API, CLI, Spotify).',
  },
  name_script_mixed: {
    title: 'Name in the wrong script',
    explain: 'A person\'s name is written in a script other than the resource name policy.',
    fix: 'Write names as the style sheet says: transliterated or in the original Latin.',
  },
  hashtags_disabled: {
    title: 'Hashtags are off',
    explain: 'The post has hashtags although hashtags are off for this resource.',
    fix: 'Remove the hashtags, or switch hashtags to Vocabulary in the style sheet.',
  },
  hashtag_not_in_vocabulary: {
    title: 'Hashtag not in the vocabulary',
    explain: 'In vocabulary mode the post used a hashtag that is not in the resource list.',
    fix: 'Use a hashtag from the vocabulary, or add it to the list.',
  },
  units_latin: {
    title: 'Units in Latin letters',
    explain: 'The style asks for units in words, but the post writes "3B" or "270M" (model names stay as they are).',
    fix: 'Write the units in words (3 billion, 270 million).',
  },
  // T9 variety and audience level.
  monotony_opening: {
    title: 'Same opening again',
    explain: 'The post opens like several recent posts (a number and a noun, the same first word or subheading).',
    fix: 'Open with the most interesting fact in a different shape.',
  },
  monotony_phrase: {
    title: 'Phrase used in recent posts',
    explain: 'A three-to-five-word phrase repeats across the recent posts of the resource.',
    fix: 'Find another wording for it.',
  },
  monotony_format_topic: {
    title: 'Same format and topic twice a day',
    explain: 'Two posts of the same format and topic went out on one day.',
    fix: 'Vary the format or move one of the posts to another day.',
  },
  jargon_over_level: {
    title: 'Unexplained jargon',
    explain: 'The post uses more unexplained technical terms than the audience level of the resource allows.',
    fix: 'Explain each term in plain words, or drop the ones the reader does not need; replace a feed that is too technical.',
  },
  // T11 media.
  image_not_from_source: {
    title: 'Image not from the source',
    explain: 'A news post carries an image other than the source article\'s own picture.',
    fix: 'Use the source image or publish without an image.',
  },
  poster_mismatch: {
    title: 'Poster does not fit',
    explain: 'An AI poster is off topic for the post, or used on a news post (error).',
    fix: 'Pick a poster whose use matches the topic, or publish without one; never on news.',
  },
  // runIntegrityChecks: a check that threw.
  check_failed: {
    title: 'Check failed',
    explain: 'One of the checks crashed on this post, so its rule was not verified.',
    fix: 'Nothing to change in the post; report the error to the developer.',
  },
};

/** The catalogue entry of a code; a code without an entry gets its task's group and a generic text. */
export function catalogueEntry(code: string): CodeCatalogueEntry {
  const task = INTEGRITY_CODES[code]?.task ?? (code.startsWith('slop_') ? '034' : '');
  const e = CODE_EXPLANATIONS[code] ?? {
    title: code.replace(/_/g, ' '),
    explain: 'An integrity rule found an issue in this post.',
    fix: 'Read the excerpt and correct the post.',
  };
  return { code, task, ...e, group: GROUP_OF_TASK[task] ?? null, section: SECTION_OF_TASK[task] ?? 'lint' };
}

/** The digest flag a code counts towards (null: listed in the notes, not a digest flag). */
export const auditFlagOf = (code: string): AuditFlag | null => catalogueEntry(code).group;
