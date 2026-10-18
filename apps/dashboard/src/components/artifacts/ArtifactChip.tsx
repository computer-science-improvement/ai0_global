// An artifact a chat message made or names (spec 048 FR-005): type icon, title, status and version, read live so a
// setup going from "analyzing" to "ready" shows it. A click opens the artifact panel.

import { createContext, useContext } from 'react';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { useArtifact, type ArtifactChip as Chip, type ArtifactType } from '../../api/artifacts';
import { ARTIFACT_META, artifactTone, statusLabel } from '../../lib/artifacts';

export function ArtifactChip({ chip, active, onOpen }: { chip: Chip; active?: boolean; onOpen: (type: ArtifactType, id: string) => void }) {
  const q = useArtifact(chip.type, chip.id);
  const meta = ARTIFACT_META[chip.type];
  const row = q.data?.row;
  const gone = !!q.error;
  const status = row?.status ?? chip.status;
  const title = row?.title ?? (chip.title && chip.title !== chip.type ? chip.title : meta.label);
  return (
    <button type="button" className="row-lift" onClick={() => onOpen(chip.type, chip.id)} aria-pressed={active}
      title={gone ? 'This artifact is no longer available' : `Open ${title}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8, maxWidth: '100%', minWidth: 0, padding: '6px 10px',
        border: `1px solid ${active ? 'var(--color-accent)' : 'var(--color-hairline)'}`, borderRadius: 'var(--radius-md)',
        background: active ? 'var(--color-surface-3)' : 'var(--color-surface-2)', color: 'var(--color-ink)', cursor: 'pointer', textAlign: 'left',
        opacity: gone ? 0.6 : 1,
      }}>
      <Icon name={meta.icon} size={14} />
      <span style={{ display: 'grid', minWidth: 0 }}>
        <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{meta.label}</span>
        <span className="text-body-sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
      </span>
      {status && <Badge tone={artifactTone(status)}>{statusLabel(status)}</Badge>}
      {row?.version != null && <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-muted)', flexShrink: 0 }}>v{row.version}</span>}
    </button>
  );
}

/** The page that shows chips (the chat) opens the panel: which artifact is open and how to open one. */
export const ArtifactOpenContext = createContext<{ activeKey: string | null; open: (type: ArtifactType, id: string) => void } | null>(null);

/** `[[type:id]]` references in a message (what "Ask the agent" puts into the composer). */
export function mentionedArtifacts(text: string): Chip[] {
  const out: Chip[] = [];
  for (const m of text.matchAll(/\[\[(setup|steering|rules|memory|skill|playbook|profile|formatting):([^\]\s]{1,120})\]\]/g)) {
    if (!out.some((c) => c.type === m[1] && c.id === m[2])) out.push({ type: m[1] as ArtifactType, id: m[2], title: '', status: '' });
  }
  return out;
}

export function ArtifactChips({ chips }: { chips: Chip[] }) {
  const ctx = useContext(ArtifactOpenContext);
  if (!chips.length || !ctx) return null;
  const { activeKey, open: onOpen } = ctx;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
      {chips.map((c) => <ArtifactChip key={`${c.type}:${c.id}`} chip={c} active={activeKey === `${c.type}:${c.id}`} onOpen={onOpen} />)}
    </div>
  );
}
