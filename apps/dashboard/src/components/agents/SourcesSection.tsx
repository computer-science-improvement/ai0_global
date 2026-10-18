// Spec 049 FR-003: how the channel card's sources behaved over 14 days — one card-row per source (state, reads that
// worked, the last error, the slots it cost), worst first, plus the blocked sites the agent's runs hit outside them.
// The agent proposes a replacement for a source that keeps failing (FR-004); its card waits in "Waiting for you".

import { SectionCard } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon, type IconName } from '../ui/Icon';
import { fmtRelative } from '../../lib/format';
import { useAgentSources, type SourceHealth, type SourceState } from '../../api/agents';

const STATE: Record<SourceState, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  blocked:   { label: 'Blocked', tone: 'danger' },
  failing:   { label: 'Failing', tone: 'danger' },
  exhausted: { label: 'Nothing new', tone: 'warning' },
  ok:        { label: 'Working', tone: 'success' },
  unused:    { label: 'Not read', tone: 'neutral' },
};

const KIND_ICON: Record<SourceHealth['kind'], IconName> = { rss: 'radar', url: 'globe', library: 'database', api: 'link' };

function SourceRow({ s, i }: { s: SourceHealth; i: number }) {
  const st = STATE[s.state];
  return (
    <div className="card compose-rise" style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 14px', animationDelay: `${i * 30}ms`, flexWrap: 'wrap' }}>
      <span style={{ color: 'var(--color-ink-muted)', paddingTop: 2 }}><Icon name={KIND_ICON[s.kind]} size={16} /></span>
      <div style={{ flex: '1 1 240px', minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--color-ink)', fontWeight: 500 }}>{s.id}</span>
          <Badge tone={st.tone}>{st.label}</Badge>
          {s.slotsLost > 0 && <Badge tone="warning">{s.slotsLost} slot{s.slotsLost === 1 ? '' : 's'} lost</Badge>}
        </div>
        <div className="text-micro truncate" style={{ color: 'var(--color-ink-dim)' }} title={s.ref}>{s.kind} · {s.ref}</div>
        <div className="text-micro clamp" style={{ color: 'var(--color-ink-muted)', marginTop: 4 }} title={s.detail}>{s.detail}</div>
      </div>
      <div style={{ textAlign: 'right', minWidth: 90 }}>
        <div className="tabular-nums" style={{ color: 'var(--color-ink)' }}>{s.successRate === null ? '—' : `${Math.round(s.successRate * 100)}%`}</div>
        <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>
          {s.calls ? `${s.ok}/${s.calls} reads` : 'no reads'}
        </div>
        {s.lastOkAt && <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>ok {fmtRelative(s.lastOkAt)}</div>}
      </div>
    </div>
  );
}

export function SourcesSection({ handle, delay = 60 }: { handle: string; delay?: number }) {
  const q = useAgentSources(handle);
  const r = q.data;
  if (!r || (!r.sources.length && !r.otherHosts.length)) return null;
  const bad = r.sources.filter((s) => s.state === 'blocked' || s.state === 'failing' || s.state === 'exhausted').length;
  return (
    <SectionCard title="Sources" icon="radar" delay={delay} style={{ marginBottom: 16 }}
      action={<span className="text-micro" style={{ color: bad ? 'var(--color-warning)' : 'var(--color-ink-dim)' }}>
        {bad ? `${bad} not working · ` : ''}{r.days} days
      </span>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {r.sources.map((s, i) => <SourceRow key={s.id} s={s} i={i} />)}
      </div>
      {bad > 0 && (
        <div className="text-micro" style={{ marginTop: 10, color: 'var(--color-ink-muted)' }}>
          The agent looks for a replacement of a source that keeps failing; its proposal waits in "Waiting for you" with Apply / Discard.
        </div>
      )}
      {r.otherHosts.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="text-micro" style={{ color: 'var(--color-ink-dim)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>Blocked sites the agent tried</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {r.otherHosts.map((h) => (
              <span key={h.host} className="chip" title={`${h.reason}${h.statusCode ? ` ${h.statusCode}` : ''} · until ${new Date(h.until).toLocaleString('en-GB')}`}>
                {h.host} · {h.calls}×
              </span>
            ))}
          </div>
        </div>
      )}
    </SectionCard>
  );
}
