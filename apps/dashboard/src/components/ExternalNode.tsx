// apps/dashboard/src/components/ExternalNode.tsx
//
// Ghost node for graph edges that point to targets we don't track as
// channels — `web` (raw domains like teleads.com.ua, t.me invite links),
// `instagram` handles, or `tg_user` (DM targets, not channels). They have
// no subscriber count, no title, no ROI. Rendered dimmed + dashed border
// so they read as "external reference" at a glance.

import { Handle, Position } from 'reactflow';

export interface ExternalNodeData {
  /** Raw username / domain / handle from the post text. */
  target:     string;
  /** Edge kind that resolved here. Drives the color of the icon. */
  kind:       string;
  /** Layout direction hint — same as ChannelNode. */
  horizontal?: boolean;
}

const KIND_GLYPH: Record<string, string> = {
  web:       '🔗',
  instagram: '📷',
  tg_user:   '👤',
  tg_channel: '#',  // shouldn't appear here since those resolve, but fallback
};

export function ExternalNode({ data }: { data: ExternalNodeData }) {
  const horizontal = data.horizontal === true;
  const targetSide = horizontal ? Position.Left  : Position.Top;
  const sourceSide = horizontal ? Position.Right : Position.Bottom;

  const glyph = KIND_GLYPH[data.kind] ?? '?';

  return (
    <div
      style={{
        borderRadius: 'var(--radius-md)',
        border: '1px dashed var(--color-hairline)',
        background: 'transparent',
        padding: '8px 12px',
        fontSize: 11,
        minWidth: 120,
        maxWidth: 180,
        color: 'var(--color-ink-muted)',
      }}
      title={`External ${data.kind} — not a tracked channel`}
    >
      <Handle type="target" position={targetSide} style={{ background: 'var(--color-hairline-soft)', width: 6, height: 6 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12 }}>{glyph}</span>
        <span style={{ fontWeight: 500, color: 'var(--color-ink-muted)' }} className="truncate">
          {data.target}
        </span>
      </div>
      <div className="text-micro" style={{ marginTop: 2, color: 'var(--color-ink-dim)' }}>
        external · {data.kind}
      </div>
      <Handle type="source" position={sourceSide} style={{ background: 'var(--color-hairline-soft)', width: 6, height: 6 }} />
    </div>
  );
}
