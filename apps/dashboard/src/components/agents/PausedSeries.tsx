// Spec 060 FR-001: the series the dead-series breaker (or the owner, from a Telegram card) paused on this agent's
// channel — why, since when, and Resume. The planner stops planning a paused series and its planned slots are skipped
// at no cost; Resume lets it be planned again. Nothing is shown when no series is paused (or the server has no endpoint).

import { SectionCard } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { toast } from '../ui/Toast';
import { fmtRelative } from '../../lib/format';
import { useResumeSeries, useSeriesPauses, type SeriesPause, type SeriesPauseCause } from '../../api/agents';

const CAUSE: Record<SeriesPauseCause, { label: string; tone: 'warning' | 'neutral' }> = {
  no_material:        { label: 'No material', tone: 'warning' },
  source_unreachable: { label: 'Source unreachable', tone: 'warning' },
  owner:              { label: 'Paused by you', tone: 'neutral' },
};

function PauseRow({ p, i, handle }: { p: SeriesPause; i: number; handle: string }) {
  const resume = useResumeSeries(handle);
  const c = CAUSE[p.cause] ?? { label: p.cause, tone: 'neutral' as const };
  return (
    <div className="card compose-rise" style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 14px', animationDelay: `${i * 30}ms`, flexWrap: 'wrap' }}>
      <span style={{ color: 'var(--color-ink-muted)' }}><Icon name="pause" size={16} /></span>
      <div style={{ flex: '1 1 240px', minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--color-ink)', fontWeight: 500, overflowWrap: 'anywhere' }}>{p.label}</span>
          <Badge tone={c.tone}>{c.label}</Badge>
        </div>
        <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>
          paused {fmtRelative(p.pausedAt)}{p.streak > 0 ? ` · ${p.streak} skips in a row` : ''}
        </div>
        {p.reason && <div className="text-micro clamp" style={{ color: 'var(--color-ink-muted)', marginTop: 4 }} title={p.reason}>{p.reason}</div>}
      </div>
      <button type="button" className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} disabled={resume.isPending}
        onClick={() => resume.mutate(p.id, { onSuccess: () => toast.success(`Resumed: ${p.label}`) })}>
        <Icon name="play" size={14} /> Resume
      </button>
    </div>
  );
}

export function PausedSeries({ handle, delay = 50 }: { handle: string; delay?: number }) {
  const q = useSeriesPauses(handle);
  const open = q.data?.open ?? [];
  if (!open.length) return null;
  return (
    <SectionCard title="Paused series" icon="pause" delay={delay} style={{ marginBottom: 16 }}
      action={<span className="text-micro" style={{ color: 'var(--color-warning)' }}>{open.length} paused</span>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {open.map((p, i) => <PauseRow key={p.id} p={p} i={i} handle={handle} />)}
      </div>
      <div className="text-micro" style={{ marginTop: 10, color: 'var(--color-ink-muted)' }}>
        A series is paused after repeated skips for the same reason (nothing to write from, or its source cannot be read). The planner does not plan it and its planned slots are skipped at no cost until you resume it.
      </div>
    </SectionCard>
  );
}
