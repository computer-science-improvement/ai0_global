import type { PostSpec } from '../post/post-spec';
import type { RenderCard } from '../post/render-telegram';
import { auditPostFromSpec } from '../post/integrity/from-post-spec';
import { bodyText, type AuditPost, type Finding } from '../post/integrity/types';
import type { AuditCard } from '../post/integrity/types';
import { assessStory, CROSS_CHANNEL_HOURS, storyView, type StoryAssessment } from './story-match';
import type { CriticStoryContext } from './story-context';
import type { StoryRegistry } from './story.repository';
import { factConflicts } from '../post/fact-conflict';

/**
 * Spec 037 T2: the story guard of publish_post. The post (as the reader will see it) is matched with the resource's
 * posts of 14 days (statuses published, shadowed, awaiting_approval, approved; evergreen 30) and the network
 * siblings' posts of 72 h (spec 041 FR-004; was 24):
 *   • a repeat (`story_repeat`) or a follow-up without new facts (`followup_without_new_facts`) is an error;
 *   • a sibling's story (or, spec 041, the same topic) within 72 h needs a decision: skip_slot, `story.decision: "own_angle"` with a reason (the post
 *     goes out with the `story_cross_channel` warning) or request_story_repost — without one the guard refuses
 *     (`story_decision_required`);
 *   • warnings (`followup_restates`, `story_cross_channel`) join the lint warnings the critic reads.
 * It also gives the critic the story's earlier posts and the reply target of a follow-up (the original's message on
 * the same channel, within 14 days).
 */

export type StoryGuardResult =
  | { error: string; details: unknown }
  | { ok: true; warnings: Finding[]; post: AuditPost; assessment: StoryAssessment; critic: CriticStoryContext | null; replyTo: number | null };

export interface StoryGuardInput {
  channelKey: string;
  slotId:     string;
  spec:       PostSpec;
  card:       Partial<RenderCard> & AuditCard & { timezone: string };
  /** The (scheduled) publish instant of the post. */
  at:         Date;
  now:        Date;
}

const FACTS_SHOWN = 6;

function factsOf(p: AuditPost): string[] {
  return [...storyView(p).entities.entities.values()].filter((e) => e.weight >= 1).sort((a, b) => b.weight - a.weight)
    .slice(0, FACTS_SHOWN).map((e) => e.text);
}

/** The critic's view of the story (null when the post has no earlier posts in its story). */
export function criticStoryOf(a: StoryAssessment, post: AuditPost): CriticStoryContext | null {
  const own = a.matches.map((m) => m.post);
  const sib = a.siblings.map((m) => m.post);
  if (!own.length && !sib.length) return null;
  const all = [...own, ...sib].sort((x, y) => Date.parse(x.publishedAt) - Date.parse(y.publishedAt));
  const lead = (p: AuditPost) => p.lead ?? bodyText(p).split('\n')[0] ?? '';
  return {
    role: a.role,
    firstPostAt: own.length ? own.map((p) => p.publishedAt).sort()[0] : null,
    posts: all.map((p) => ({ at: p.publishedAt, channel: p.channel, lead: lead(p), facts: factsOf(p), ...(sib.includes(p) ? { sibling: true } : {}) })),
    ...(post.story?.newFacts?.length ? { newFacts: post.story.newFacts } : {}),
    ...(post.story?.decision ? { decision: post.story.decision } : {}),
  };
}

export async function storyGuard(reg: Pick<StoryRegistry, 'history'>, i: StoryGuardInput): Promise<StoryGuardResult> {
  const post = auditPostFromSpec(i.spec, { id: i.slotId, channel: i.channelKey, publishedAt: i.at.toISOString(), timezone: i.card.timezone, card: i.card });
  const h = await reg.history(i.channelKey, i.slotId, i.at);
  const a = assessStory(post, { previous: h.previous, network: h.network, card: i.card, now: i.now.toISOString() });
  const errors = a.findings.filter((f) => f.level === 'error');
  if (errors.length) {
    return { error: errors[0].code, details: errors.map((f) => f.message).join(' | ') };
  }
  const st = i.spec.story;
  if (a.siblings.length && !a.matches.length && st?.kind !== 'roundup') {
    const s = a.siblings[0].post;
    const ref = s.messageIds?.[0] != null ? `telegram:${s.channel}/${s.messageIds[0]}` : null;
    if (st?.decision !== 'own_angle') {
      return {
        error: 'story_decision_required',
        details: `${s.channel} уже опублікував цю історію чи тему за останні ${CROSS_CHANNEL_HOURS} год («${(s.lead ?? bodyText(s).split('\n')[0] ?? '').slice(0, 90)}»). `
          + `Виріши: skip_slot (code story_skip), власний кут — story.decision "own_angle" і story.reason (чим твій пост інший), `
          + `або request_story_repost${ref ? ` (source_post_id ${ref})` : ' (коли пост сусіда вийде)'}.`,
      };
    }
    if (!st.reason) return { error: 'story_decision_required', details: 'own_angle потребує story.reason: чим твій пост відрізняється від посту сусіднього каналу' };
  }
  const original = a.original;
  const replyTo = a.role === 'followup' && original && original.channel === i.channelKey && original.messageIds?.[0] != null
    && Math.abs(Date.parse(post.publishedAt) - Date.parse(original.publishedAt)) <= 14 * 86_400_000
    ? original.messageIds[0] : null;
  // Spec 037 T4: a price, character or deadline told differently by an earlier post (the registry's 14 days) → warning.
  const facts = factConflicts(post, h.previous);
  return { ok: true, warnings: [...a.findings.filter((f) => f.level === 'warning'), ...facts], post, assessment: a, critic: criticStoryOf(a, post), replyTo };
}
