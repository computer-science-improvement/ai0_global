import { Handle, Position } from 'reactflow';
import { fmtNumber } from '../lib/format';
import type { GraphNode } from '../api/types';

type NodeData = GraphNode & { horizontal?: boolean };

export function ChannelNode({ data }: { data: NodeData }) {
  const horizontal = data.horizontal === true;
  const targetSide = horizontal ? Position.Left  : Position.Top;
  const sourceSide = horizontal ? Position.Right : Position.Bottom;

  return (
    <div style={{
      borderRadius: 'var(--radius-md)',
      border: '1px solid var(--color-hairline)',
      background: 'var(--color-surface-1)',
      padding: '10px 14px',
      fontSize: 12,
      boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
      minWidth: 140,
      maxWidth: 160,
    }}>
      <Handle type="target" position={targetSide} style={{ background: 'var(--color-hairline)', width: 6, height: 6 }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontWeight: 600, color: 'var(--color-ink)', letterSpacing: '-0.14px' }} className="truncate max-w-[120px]">
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
        <div style={{ color: 'var(--color-ink-muted)', marginTop: 2, fontSize: 11 }} className="truncate">
          @{data.username}
        </div>
      )}
      <div style={{ marginTop: 4, color: 'var(--color-ink-muted)', fontSize: 11 }} className="tabular-nums">
        {fmtNumber(data.subs)} subs
      </div>

      <Handle type="source" position={sourceSide} style={{ background: 'var(--color-hairline)', width: 6, height: 6 }} />
    </div>
  );
}
