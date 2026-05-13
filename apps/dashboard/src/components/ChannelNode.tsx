import { Handle, Position } from 'reactflow';
import { fmtNumber } from '../lib/format';
import type { GraphNode } from '../api/types';

export function ChannelNode({ data }: { data: GraphNode }) {
  return (
    <div style={{
      borderRadius: 'var(--radius-md)',
      border: '1px solid var(--color-hairline)',
      background: 'var(--color-surface-1)',
      padding: '8px 12px',
      fontSize: 12,
      boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
      minWidth: 140,
    }}>
      <Handle type="target" position={Position.Top} style={{ background: 'var(--color-hairline)' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontWeight: 600, color: 'var(--color-ink)' }} className="truncate max-w-[120px]">
          {data.title ?? data.username ?? data.id.slice(0, 6)}
        </span>
        {data.isMine && (
          <span style={{
            background: 'rgba(34,197,94,0.18)',
            color: 'var(--color-success)',
            borderRadius: 'var(--radius-pill)',
            padding: '1px 6px',
            fontSize: 10,
            fontWeight: 600,
          }}>
            mine
          </span>
        )}
      </div>
      {data.username && (
        <div style={{ color: 'var(--color-ink-muted)', marginTop: 2 }} className="truncate">
          @{data.username}
        </div>
      )}
      <div style={{ marginTop: 4, color: 'var(--color-ink-muted)' }} className="tabular-nums">
        {fmtNumber(data.subs)} subs
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: 'var(--color-hairline)' }} />
    </div>
  );
}
