import { fmtNumber, fmtRelative } from '../lib/format';
import type { TrackedPost } from '../api/types';
import { evergreenBadge, repostBadge } from '../lib/reposts';
import { Badge } from './ui/Badge';
import { EmptyState } from './ui/primitives';
import './channels/channels.css';

/**
 * Posts as rows of a flush panel (`<SectionCard flush>`): the age, repost / evergreen badges and the numbers on the first
 * line, the text (three lines at most) under it.
 */
export function PostsList({ posts }: { posts: TrackedPost[] }) {
  if (posts.length === 0) return <EmptyState icon="channels" title="No posts yet" />;
  return (
    <>
      {posts.map((p) => (
        <div key={p.id} className="panel-row ch-post">
          <div className="ch-post-head">
            <span className="ch-post-age">
              <span className="mono">{fmtRelative(p.postedAt)}</span>
              {repostBadge(p.repostFrom) && <Badge tone="accent">{repostBadge(p.repostFrom)}</Badge>}
              {evergreenBadge(p.evergreen) && <Badge tone="neutral">{evergreenBadge(p.evergreen)}</Badge>}
            </span>
            <span className="ch-post-stats mono">
              <span><b>{fmtNumber(p.views)}</b> views</span>
              <span><b>{fmtNumber(p.forwards)}</b> forwards</span>
              <span><b>{fmtNumber(p.reactionsTotal)}</b> reactions</span>
              <span><b>{fmtNumber(p.commentsCount)}</b> comments</span>
            </span>
          </div>
          <p className={`ch-post-text clamp${p.text ? '' : ' is-empty'}`}>
            {p.text ?? '(media only)'}
          </p>
        </div>
      ))}
    </>
  );
}
