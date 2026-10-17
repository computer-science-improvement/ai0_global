/**
 * Spec 042: a channel's own post as the setup analysis reads it (a `tracked_posts` row). `key` is the short id the model sees
 * (`p1` = the newest), so evidence never carries a uuid the model could garble.
 */
export interface SetupPost {
  key:            string;
  id:             string;
  msgId:          number;
  postedAt:       Date;
  text:           string;
  hasMedia:       boolean;
  mediaType:      string | null;
  views:          number | null;
  forwards:       number | null;
  reactionsTotal: number | null;
  comments:       number | null;
}

/** How many of the latest posts the analysis reads, and the fewest it can learn from (FR-001). */
export const POSTS_TO_READ = 20;
export const MIN_POSTS = 5;
/** Spec 041 FR-008: the fewest posts with text the style can be learnt from (fewer: `insufficient_data`, no LLM run). */
export const MIN_TEXT_POSTS = 5;
/** A post this short is media with a caption, not text to learn a style from. */
export const TEXT_POST_MIN_CHARS = 20;
/** Spec 041 FR-008: fewer days of history and the posting rate and quiet hours are not proposed (`insufficient_span`). */
export const MIN_SPAN_DAYS = 7;

export const hasPostText = (p: { text: string }) => p.text.trim().length >= TEXT_POST_MIN_CHARS;

/** The post as the model reads it, cut at this many characters (FR-003). */
export const POST_TEXT_IN_PROMPT = 1500;
