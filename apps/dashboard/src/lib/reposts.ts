// Spec 037 T2: reposts (native forwards of a network sibling's post) are counted apart from the channel's own posts.

export interface RepostLike { repostFrom?: string | null; views: number | null }

export interface RepostSplit {
  own: number;
  reposts: number;
  /** reposts / all, 0–1; null without posts. */
  share: number | null;
  /** Average views of the own posts only (reposts carry the sibling's audience); null without own posts. */
  avgOwnViews: number | null;
}

export function splitReposts(posts: RepostLike[]): RepostSplit {
  const own = posts.filter((p) => !p.repostFrom);
  const reposts = posts.length - own.length;
  const views = own.map((p) => p.views ?? 0);
  return {
    own: own.length,
    reposts,
    share: posts.length ? reposts / posts.length : null,
    avgOwnViews: views.length ? Math.round(views.reduce((a, b) => a + b, 0) / views.length) : null,
  };
}

/** The badge of a forwarded post: "Repost from @channel". */
export function repostBadge(from: string | null | undefined): string | null {
  if (!from) return null;
  return `Repost from @${from.replace(/^@/, '')}`;
}
