import { hashtagFindings } from '../../style/style-rules';
import type { IntegrityCheck } from '../types';

/**
 * Spec 037 FR-008 (T8): `hashtags_disabled` (error) — any hashtag on a resource with `style.hashtags = off` (the
 * owner's default for news resources): the post's hashtags and a `#word` in the text (not in links or code). In
 * `vocabulary` mode lintPost's `hashtag_not_in_vocabulary` keeps working on card.hashtags.
 */
export const styleHashtagsCheck: IntegrityCheck = {
  id: 'style-hashtags',
  codes: ['hashtags_disabled'],
  run: (post, ctx) => hashtagFindings(post.text, post.hashtags, ctx.card?.style),
};
