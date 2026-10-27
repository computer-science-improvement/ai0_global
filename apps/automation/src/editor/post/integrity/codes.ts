import { SLOP_WARNING_CODES } from '../slop-lint';

/**
 * Spec 037: the finding codes of the content-integrity epic, the task that owns each and its level. The golden-set
 * labels (`testing/channel-logs-2026-10.labels.json`) may only use these names, so a typo fails the test and a
 * later task implements exactly the code its rows expect. `mixed` = the level depends on the case (e.g. a lead over
 * 140 chars is a warning, over 220 an error). A task that renames or adds a code updates this list and the labels.
 */
export type CodeLevel = 'error' | 'warning' | 'mixed';

export interface CodeInfo { task: string; level: CodeLevel; what: string }

export const INTEGRITY_CODES: Record<string, CodeInfo> = {
  // Spec 034 (enforced by lintPost; adapters in integrity/checks/).
  banned_term:                { task: '034', level: 'error',   what: 'listed AI phrase (slop-phrases.ts) or an owner banned term' },
  reader_questions:           { task: '034', level: 'error',   what: 'questions to the readers over the resource cap' },
  ...Object.fromEntries(SLOP_WARNING_CODES.map((c) => [c, { task: '034', level: 'warning' as const, what: 'slop counter (slop-lint.ts)' }])),
  slop_emoji_tail:            { task: '063', level: 'warning', what: 'the post ends with an emoji on a channel that limits emoji (format_prefs.emoji none / light)' },
  slop_analogy_opener:        { task: '063', level: 'warning', what: 'analogy opener («X — це як Y», «Уявіть, що…») used by ≥ 2 of the last 5 posts' },
  // T2 story registry.
  story_repeat:               { task: 'T2', level: 'error',   what: 'same story as a post of the last 14 days without a follow-up' },
  followup_without_new_facts: { task: 'T2', level: 'error',   what: 'follow-up whose new facts are absent or already in the original' },
  followup_restates:          { task: 'T2', level: 'warning', what: 'follow-up restating more than half of the original' },
  story_cross_channel:        { task: 'T2', level: 'warning', what: 'a sibling channel posted the story or topic in the last 72 h (own angle / repost / skip)' },
  // T3 announcement → recap (digest level, not per post).
  event_not_covered:          { task: 'T3', level: 'warning', what: 'announced event without a recap within 24 h' },
  event_date_missing:         { task: 'T3', level: 'error',   what: 'an announcement (story.event_at) whose text does not name the event date / time' },
  // T4 facts and sources.
  number_not_in_sources:      { task: 'T4', level: 'warning', what: 'a number of the post not found in the fetched sources' },
  fact_conflict:              { task: 'T4', level: 'warning', what: 'a fact differs from a previous post of the story' },
  source_is_homepage:         { task: 'T4', level: 'error',   what: 'source URL is a site root or a section index' },
  low_tier_claim:             { task: 'T4', level: 'warning', what: 'numbers taken from a low-tier source ("fun facts" pages)' },
  source_aggregator:          { task: 'T4', level: 'warning', what: 'aggregator source whose page links the primary source (take the primary)' },
  // T5 dates and freshness.
  date_relative_mismatch:     { task: 'T5', level: 'error',   what: 'relative word and explicit date disagree with the publish date' },
  weekday_mismatch:           { task: 'T5', level: 'error',   what: 'weekday does not match the date' },
  relative_date_unanchored:   { task: 'T5', level: 'warning', what: '«завтра» / «з завтра» in news without an explicit date' },
  stale_now_word:             { task: 'T5', level: 'warning', what: '«щойно» / «прямо зараз» about something older than 24 h' },
  deal_expired:               { task: 'T5', level: 'error',   what: 'giveaway / deal deadline not after the publish time' },
  deal_expiring:              { task: 'T5', level: 'warning', what: 'giveaway / deal ends in under 6 h' },
  stale_source:               { task: 'T5', level: 'warning', what: 'source older than the freshness threshold (news 36 h, games 72 h)' },
  // T6 text hygiene.
  text_replacement_char:      { task: 'T6', level: 'error',   what: 'U+FFFD, control chars, zero-width inside words, mojibake' },
  mixed_script_word:          { task: 'T6', level: 'error',   what: 'Cyrillic and Latin letters in one word or hashtag' },
  process_leak:               { task: 'T6', level: 'mixed',   what: 'a sentence about the agent\'s own work' },
  duplicate_attribution:      { task: 'T6', level: 'warning', what: '«Джерело: X» in the text next to the rendered source line' },
  duplicate_source_link:      { task: '063', level: 'warning', what: 'the source URL as an inline anchor and as the rendered source line / button' },
  lead_too_long:              { task: 'T6', level: 'mixed',   what: 'bold lead over 140 chars (warning) / 220 (error)' },
  decimal_mixed:              { task: 'T6', level: 'warning', what: 'both «1,05» and «0.10» decimal separators in one post' },
  verbatim_repeat:            { task: 'T6', level: 'warning', what: 'a 4+-word sequence repeated inside one post' },
  slop_cliche:                { task: 'T6', level: 'warning', what: 'soft slop phrase («це той випадок, коли», sentence-initial «коротко —»)' },
  // T7 polls and quizzes.
  knowledge_poll:             { task: 'T7', level: 'warning', what: 'a knowledge question as a regular poll (should be a quiz)' },
  quiz_answer_revealed:       { task: 'T7', level: 'error',   what: 'the right answer is in the intro, the companion post or a story post of 24 h' },
  poll_cap_reached:           { task: 'T7', level: 'error',   what: 'polls + quizzes over polls_per_week on actual posts' },
  // T8 resource style sheet.
  address_mixed:              { task: 'T8', level: 'mixed',   what: 'ти and ви in one post (error) or a form other than the resource\'s (warning)' },
  glossary_violation:         { task: 'T8', level: 'error',   what: 'banned transliteration / translated brand (АПІ, КЛІ, Разом AI, спотифай)' },
  name_script_mixed:          { task: 'T8', level: 'warning', what: 'a person\'s name in a script other than the resource policy' },
  hashtag_while_off:          { task: 'T8', level: 'error',   what: 'a hashtag on a resource with style.hashtags = off' },
  hashtag_not_in_vocabulary:  { task: 'T8', level: 'error',   what: 'vocabulary mode: hashtag outside card.hashtags' },
  units_latin:                { task: 'T8', level: 'warning', what: 'style.units = words: «3B», «270M» instead of «3 млрд», «270 млн» (model names stay)' },
  // T9 variety and audience level.
  monotony_opening:           { task: 'T9', level: 'warning', what: 'opening pattern repeated in the last 20 posts («5 X», «Що X:», same first word)' },
  monotony_phrase:            { task: 'T9', level: 'warning', what: 'a 3–5-word phrase shared with recent posts' },
  monotony_format_topic:      { task: 'T9', level: 'warning', what: 'same format and topic twice a day' },
  jargon_over_level:          { task: 'T9', level: 'warning', what: 'unexplained jargon over the audience level budget' },
  // T10 evergreen fallback (story.kind evergreen only).
  evergreen_dated:            { task: 'T10', level: 'error',   what: 'an evergreen post with «щойно» / «сьогодні» / «новина» or another news anchor' },
  evergreen_unsourced_number: { task: 'T10', level: 'warning', what: 'an evergreen post with specific numbers (%, sums, millions) and no source' },
  // T11 media.
  image_not_from_source:      { task: 'T11', level: 'error',  what: 'news media other than the source\'s own image' },
  poster_mismatch:            { task: 'T11', level: 'mixed',  what: 'ai_posters poster on a news post (error), or off topic (error before publishing, warning in the post audit; the message names the posters that fit)' },
  // Spec 041 T1 language gate (post/language/lexicon.ts).
  language_calque:            { task: '041', level: 'error',   what: 'an unambiguous russism / calque («приймати участь», «на протязі», «являється», «заточений»)' },
  language_case:              { task: '041', level: 'warning', what: 'a suspect case («трапляється у найвідоміших сервісів» → «з …ими»)' },
  language_suspect:           { task: '041', level: 'warning', what: 'a contested or context-dependent calque («вражаючий», «на борту» outside a vehicle, «по рампі» for a path)' },
  language_euphony:           { task: '041', level: 'warning', what: 'у/в, і/й against the alternation rule, with the exact replacement' },
  brief_media_missing:        { task: '041', level: 'error',   what: 'the brief asks for a picture on this format and the post has none' },
  topic_repeat:               { task: 'T2', level: 'error',   what: '(041) an evergreen post (explainer, how-to, glossary, listicle) on a topic of the last 30 days' },
};

/** `code@T6` in a label: expected once task T6 extends an already implemented check. Returns the bare code and the task. */
export function parseLabelCode(label: string): { code: string; pendingTask?: string } {
  const [code, task] = label.split('@');
  return task ? { code, pendingTask: task } : { code };
}
