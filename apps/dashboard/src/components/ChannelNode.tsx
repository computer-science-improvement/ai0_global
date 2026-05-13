import { Handle, Position } from 'reactflow';
import { fmtNumber } from '../lib/format';
import type { GraphNode } from '../api/types';

export function ChannelNode({ data }: { data: GraphNode }) {
  return (
    <div className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs shadow-md min-w-[140px]">
      <Handle type="target" position={Position.Top} className="!bg-neutral-500" />
      <div className="flex items-center gap-1.5">
        <span className="font-semibold truncate max-w-[120px]">{data.title ?? data.username ?? data.id.slice(0, 6)}</span>
        {data.isMine && <span className="rounded bg-emerald-700 px-1 text-[10px]">mine</span>}
      </div>
      {data.username && <div className="text-neutral-400 truncate">@{data.username}</div>}
      <div className="mt-1 text-neutral-500">{fmtNumber(data.subs)} subs</div>
      <Handle type="source" position={Position.Bottom} className="!bg-neutral-500" />
    </div>
  );
}
