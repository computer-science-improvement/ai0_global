import { fmtNumber, fmtRelative } from '../lib/format';
import type { TrackedPost } from '../api/types';

export function PostsList({ posts }: { posts: TrackedPost[] }) {
  return (
    <div className="space-y-2">
      {posts.map((p) => (
        <div key={p.id} className="rounded-lg bg-neutral-900 p-3">
          <div className="flex items-center justify-between text-xs text-neutral-400">
            <span>{fmtRelative(p.postedAt)}</span>
            <span>👁 {fmtNumber(p.views)} · 🔁 {fmtNumber(p.forwards)} · ❤ {fmtNumber(p.reactionsTotal)} · 💬 {fmtNumber(p.commentsCount)}</span>
          </div>
          <p className="mt-2 line-clamp-3 text-sm">{p.text ?? <em className="text-neutral-500">(media only)</em>}</p>
        </div>
      ))}
    </div>
  );
}
