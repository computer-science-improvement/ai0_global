import type { Pool } from 'pg';
import { personNames, textHashtags } from './style-rules';
import type { ResourceStyle } from './resource-style';
import { resourceStyleOf } from './style-store';

/**
 * Spec 037 FR-008 (T8): the style bootstrap. From the resource's posts of the last 60 days it proposes a names policy
 * (Latin vs Cyrillic person names) and, only for a `hashtags: vocabulary` resource, a hashtag vocabulary with
 * variants merged («#роздачі» → «#роздача», «#open_source» → «#opensource»). It is a proposal: nothing is stored
 * here; the owner accepts it in Resource → Formatting → Style sheet (and the vocabulary goes to card.hashtags).
 */

export const PROPOSAL_DAYS = 60;
/** Fewer name uses than this propose no names policy. */
const MIN_NAMES = 3;
/** A hashtag joins the proposed vocabulary from this many posts. */
const MIN_TAG_POSTS = 2;
const MAX_VOCABULARY = 20;

export interface ProposalPost { text: string; hashtags: string[] }

export interface HashtagGroup {
  /** The proposed form (no underscore preferred, then the most used variant). */
  tag:      string;
  /** Posts that used any variant. */
  count:    number;
  variants: Array<{ tag: string; count: number }>;
}

export interface StyleProposal {
  ref:      string;
  days:     number;
  posts:    number;
  names:    { latin: number; cyrillic: number; examples: { latin: string[]; cyrillic: string[] }; propose: 'uk_translit' | 'original' | null };
  /** null: the resource is not in vocabulary mode (hashtags off, or no posts). */
  hashtags: { groups: HashtagGroup[]; propose: string[] } | null;
  /** What accepting changes (style fields; `vocabulary` goes to card.hashtags). Empty = nothing to propose. */
  propose:  { names?: 'uk_translit' | 'original'; vocabulary?: string[] };
}

/**
 * The key two variants of a hashtag share: lowercase, no underscores, without a final Ukrainian vowel ending
 * («роздачі» / «роздача» → «роздач»; «open_source» / «opensource» → «opensource»). ШІ / AI stay apart (owner).
 */
export function hashtagKey(tag: string): string {
  const t = tag.replace(/^#/, '').toLowerCase().replace(/_/g, '');
  return /[а-яіїєґ]/.test(t) && t.length > 4 ? t.replace(/[аяіиоуюєїе]+$/u, '') : t;
}

/** Hashtag groups of a set of posts (each post counts once per group), most used first. */
export function hashtagGroups(posts: readonly ProposalPost[]): HashtagGroup[] {
  const groups = new Map<string, Map<string, number>>();
  for (const p of posts) {
    const tags = [...new Set([...p.hashtags, ...textHashtags(p.text)].map((h) => h.replace(/^#/, '').toLowerCase()))];
    const seen = new Set<string>();
    for (const t of tags) {
      const k = hashtagKey(t);
      if (seen.has(k)) continue;
      seen.add(k);
      const g = groups.get(k) ?? new Map<string, number>();
      g.set(t, (g.get(t) ?? 0) + 1);
      groups.set(k, g);
    }
  }
  return [...groups.values()].map((g) => {
    const variants = [...g.entries()].map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => Number(a.tag.includes('_')) - Number(b.tag.includes('_')) || b.count - a.count || a.tag.length - b.tag.length);
    return { tag: variants[0].tag, count: variants.reduce((n, v) => n + v.count, 0), variants };
  }).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** The proposal from posts and the resource's effective style (pure). */
export function buildStyleProposal(ref: string, posts: readonly ProposalPost[], style: ResourceStyle, days = PROPOSAL_DAYS): StyleProposal {
  const latin: string[] = [];
  const cyrillic: string[] = [];
  for (const p of posts) {
    const n = personNames(p.text);
    latin.push(...n.latin);
    cyrillic.push(...n.cyrillic);
  }
  const total = latin.length + cyrillic.length;
  const names: 'uk_translit' | 'original' | null = total >= MIN_NAMES ? (latin.length > cyrillic.length ? 'original' : 'uk_translit') : null;
  const uniq = (xs: string[]) => [...new Set(xs)].slice(0, 5);

  let hashtags: StyleProposal['hashtags'] = null;
  if (style.hashtags === 'vocabulary' && posts.length) {
    const groups = hashtagGroups(posts);
    hashtags = { groups: groups.slice(0, 40), propose: groups.filter((g) => g.count >= MIN_TAG_POSTS).slice(0, MAX_VOCABULARY).map((g) => g.tag) };
  }
  const propose: StyleProposal['propose'] = {};
  if (names && names !== style.names) propose.names = names;
  if (hashtags?.propose.length) propose.vocabulary = hashtags.propose;
  return {
    ref, days, posts: posts.length,
    names: { latin: latin.length, cyrillic: cyrillic.length, examples: { latin: uniq(latin), cyrillic: uniq(cyrillic) }, propose: names },
    hashtags, propose,
  };
}

/**
 * Published posts of a resource in the last `days`: the editor's Telegram posts (rendered text + spec hashtags) for
 * `telegram:<key>`, the platform captions otherwise. Read-only.
 */
export async function loadProposalPosts(pool: Pick<Pool, 'query'>, ref: string, now: Date, days = PROPOSAL_DAYS): Promise<ProposalPost[]> {
  const since = new Date(now.getTime() - days * 86_400_000);
  if (ref.startsWith('telegram:')) {
    const { rows } = await pool.query(
      `SELECT rendered_preview AS text, post_spec->'hashtags' AS hashtags FROM editor_slots
        WHERE status = 'published' AND channel_key = $1 AND (resource_ref IS NULL OR resource_ref = $2)
          AND scheduled_at >= $3 AND scheduled_at <= $4
        ORDER BY scheduled_at DESC LIMIT 500`,
      [ref.slice('telegram:'.length), ref, since, now]);
    return rows.map((r) => ({ text: r.text ?? '', hashtags: Array.isArray(r.hashtags) ? r.hashtags.map(String) : [] }));
  }
  const { rows } = await pool.query(
    `SELECT caption AS text FROM platform_posts WHERE resource_ref = $1 AND status = 'published' AND posted_at >= $2 AND posted_at <= $3
      ORDER BY posted_at DESC LIMIT 500`, [ref, since, now]);
  return rows.map((r) => ({ text: r.text ?? '', hashtags: [] }));
}

/** The proposal of one resource (reads the DB, writes nothing). */
export async function proposeStyle(pool: Pick<Pool, 'query'>, ref: string, now: Date = new Date()): Promise<StyleProposal> {
  const [posts, style] = await Promise.all([loadProposalPosts(pool, ref, now), resourceStyleOf(pool, ref)]);
  return buildStyleProposal(ref, posts, style.effective);
}
