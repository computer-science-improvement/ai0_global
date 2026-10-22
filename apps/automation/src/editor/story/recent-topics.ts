import { evergreenKind } from './evergreen-kind';
import { sameTopic, topicKey } from './topic-key';

/**
 * Spec 041 FR-004 (T4): the topics a resource covered in the last 30 days, for the idea pool and the planners. Review
 * 2 found the orchestrator re-proposing explainers the channel had run a week before: the 14-day text similarity of
 * add_idea missed them (another wording, the same topic). A topic is the title (excerpt) of a published post.
 */

export const RECENT_TOPIC_DAYS = 30;
/** At most this many topics in a prompt. */
export const RECENT_TOPICS_IN_PROMPT = 30;

export interface RecentTopic { title: string; key: string[] }

export function recentTopicsOf(titles: readonly string[]): RecentTopic[] {
  const seen = new Set<string>();
  const out: RecentTopic[] = [];
  for (const raw of titles) {
    const title = raw.split('\n')[0].trim().slice(0, 140);
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    const key = topicKey({ title });
    if (key.length) out.push({ title, key });
  }
  return out;
}

/** The recent topic an idea or a slot topic repeats (null when none). */
export function recentTopicHit(text: { title: string; angle?: string | null }, recent: readonly RecentTopic[]): (RecentTopic & { shared: string[] }) | null {
  const key = topicKey({ title: text.title, lead: text.angle ?? null });
  for (const r of recent) {
    const shared = sameTopic(key, r.key);
    if (shared) return { ...r, shared };
  }
  return null;
}

/**
 * An evergreen idea or slot topic (an explainer, a how-to, a glossary entry, a listicle) — the ones the 30-day topic
 * rule applies to; a news topic is the story guard's business (a new fact on a known product is a follow-up, not a
 * repeat).
 */
export const isEvergreenTopic = (title: string, angle?: string | null) => evergreenKind({ title, lead: angle ?? null, hasSource: true }) !== null;

/** The prompt block: the topics of 30 days (Ukrainian, like the prompts). */
export function recentTopicsBlock(recent: readonly RecentTopic[]): string | null {
  if (!recent.length) return null;
  return [
    `## Теми за ${RECENT_TOPIC_DAYS} днів (пояснення, поради, «що таке» на ці теми не повторюй — код відмовить)`,
    ...recent.slice(0, RECENT_TOPICS_IN_PROMPT).map((r) => `- ${r.title}`),
  ].join('\n');
}

/** The titles of a resource's posts of `days` days (network_posts: Telegram and platform posts), newest first. */
export async function loadRecentTopics(pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }, refs: readonly string[], days = RECENT_TOPIC_DAYS): Promise<RecentTopic[]> {
  if (!refs.length) return [];
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(excerpt, '') AS t FROM network_posts
        WHERE resource_ref = ANY($1::text[]) AND posted_at >= now() - ($2 || ' days')::interval
        ORDER BY posted_at DESC LIMIT 200`, [[...refs], String(days)]);
    return recentTopicsOf(rows.map((r) => String(r.t)));
  } catch {
    return [];
  }
}

/**
 * The planner's `topic_recent`: a fixed slot (own topic: no idea, series, directive or live source) whose evergreen
 * topic repeats one of the last 30 days.
 */
export function planTopicErrors(
  slots: ReadonlyArray<{ time: string; topic?: string; angle?: string; topic_mode?: string; idea_id?: string; series?: string | null; directive_id?: string }>,
  recent: readonly RecentTopic[],
): string[] {
  if (!recent.length) return [];
  const out: string[] = [];
  slots.forEach((s, i) => {
    if (!s.topic || s.topic_mode === 'live' || s.idea_id || s.series || s.directive_id || !isEvergreenTopic(s.topic, s.angle)) return;
    const hit = recentTopicHit({ title: s.topic, angle: s.angle }, recent);
    if (hit) out.push(`topic_recent: слот ${i + 1} (${s.time}) — тема «${s.topic.slice(0, 80)}» уже була за ${RECENT_TOPIC_DAYS} днів («${hit.title.slice(0, 80)}»): візьми іншу тему`);
  });
  return out;
}
