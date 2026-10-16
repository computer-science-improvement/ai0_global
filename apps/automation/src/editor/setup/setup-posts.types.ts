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

/** The post as the model reads it, cut at this many characters (FR-003). */
export const POST_TEXT_IN_PROMPT = 1500;
