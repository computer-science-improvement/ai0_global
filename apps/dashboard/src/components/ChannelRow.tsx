import { Link } from '@tanstack/react-router';
import { fmtNumber, fmtRelative } from '../lib/format';
import type { TrackedChannel } from '../api/types';

const TIER_COLOR: Record<TrackedChannel['pollTier'], string> = {
  hot: 'bg-rose-700', warm: 'bg-amber-700', cold: 'bg-sky-800',
};

export function ChannelRow({ c }: { c: TrackedChannel }) {
  return (
    <Link to={'/channels/$id' as any} params={{ id: c.id } as any}
      className="flex items-center justify-between rounded-lg bg-neutral-900 px-4 py-3 hover:bg-neutral-800">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">{c.title ?? c.username ?? '(no title)'}</span>
          {c.isMine && <span className="rounded bg-emerald-700 px-1.5 py-0.5 text-xs">mine</span>}
          {c.isClosed && <span className="rounded bg-neutral-700 px-1.5 py-0.5 text-xs">closed</span>}
        </div>
        {c.username && <div className="text-xs text-neutral-400">@{c.username}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-4 text-sm">
        <span className="tabular-nums">{fmtNumber(c.subsCount)}</span>
        <span className={`${TIER_COLOR[c.pollTier]} rounded px-2 py-0.5 text-xs`}>{c.pollTier}</span>
        <span className="text-neutral-400">{fmtRelative(c.lastPolledAt)}</span>
      </div>
    </Link>
  );
}
