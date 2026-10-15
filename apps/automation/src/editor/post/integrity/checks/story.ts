import { assessStory } from '../../../story/story-match';
import type { IntegrityCheck } from '../types';

/**
 * Spec 037 FR-002 (T2): one story, one post (story/story-match.ts). Needs the history: without `ctx.previous` /
 * `ctx.network` (lintPost before publishing) it finds nothing; the publish guard passes the resource's posts of
 * 14 days and the network group's of 24 h, the export audit the timeline.
 */
export const storyCheck: IntegrityCheck = {
  id: 'story',
  codes: ['story_repeat', 'followup_without_new_facts', 'followup_restates', 'story_cross_channel'],
  run: (post, ctx) => assessStory(post, ctx).findings,
  // Before publishing the story guard of publish_post enforces it with the whole history (14 / 30 days, the network's
  // 24 h, posts scheduled later): lintPost's `previous` (T9, the last 20 posts) is too short for a story.
  lintEnforced: true,
};
