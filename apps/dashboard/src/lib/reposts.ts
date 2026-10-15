// Spec 037 T2: reposts (native forwards of a network sibling's post) are counted apart from the channel's own posts.
// Spec 037 T10: so are evergreen posts (the editor's fallback for a failed slot): own, but not fresh.

export interface RepostLike { repostFrom?: string | null; evergreen?: boolean; views: number | null }

export interface RepostSplit {
  /** Own fresh posts (not reposts, not evergreen). */
  own: number;
  reposts: number;
  /** reposts / all, 0–1; null without posts. */
  share: number | null;
  /** Evergreen posts (spec 037 T10). */
  evergreen: number;
  /** evergreen / all, 0–1; null without posts. */
  evergreenShare: number | null;
  /** Average views of the own fresh posts only (reposts carry the sibling's audience); null without own posts. */
  avgOwnViews: number | null;
}

/** The share of evergreen posts above which the MANAGER flags a channel (few fresh sources). */
export const EVERGREEN_SHARE_MAX = 0.25;

export function splitReposts(posts: RepostLike[]): RepostSplit {
  const reposts = posts.filter((p) => !!p.repostFrom).length;
  const evergreen = posts.filter((p) => !p.repostFrom && p.evergreen).length;
  const own = posts.filter((p) => !p.repostFrom && !p.evergreen);
  const views = own.map((p) => p.views ?? 0);
  return {
    own: own.length,
    reposts,
    share: posts.length ? reposts / posts.length : null,
    evergreen,
    evergreenShare: posts.length ? evergreen / posts.length : null,
    avgOwnViews: views.length ? Math.round(views.reduce((a, b) => a + b, 0) / views.length) : null,
  };
}

/** The badge of an evergreen post in the posts list. */
export function evergreenBadge(evergreen: boolean | null | undefined): string | null {
  return evergreen ? 'Evergreen' : null;
}

/** The badge of a forwarded post: "Repost from @channel". */
export function repostBadge(from: string | null | undefined): string | null {
  if (!from) return null;
  return `Repost from @${from.replace(/^@/, '')}`;
}
