// Spec 049 FR-003: how the channel card's sources behaved over 14 days — one row per source (state, reads that
// worked, the last error, the slots it cost), worst first, plus the blocked sites the agent's runs hit outside them.
// The agent proposes a replacement for a source that keeps failing (FR-004); its card waits in "Waiting for you".
// Spec 078 D4: a flush panel of rows (the shape of the Health page's Sources section). Styles: agent-settings.css (ast-).

import { SectionCard, type Tone } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon, type IconName } from '../ui/Icon';
import { fmtRelative } from '../../lib/format';
import { useAgentSources, type SourceHealth, type SourceState } from '../../api/agents';

const STATE: Record<SourceState, { label: string; tone: Tone }> = {
  blocked:   { label: 'Blocked', tone: 'danger' },
  failing:   { label: 'Failing', tone: 'danger' },
  exhausted: { label: 'Nothing new', tone: 'warning' },
  ok:        { label: 'Working', tone: 'success' },
  unused:    { label: 'Not read', tone: 'neutral' },
};

const KIND_ICON: Record<SourceHealth['kind'], IconName> = { rss: 'radar', url: 'globe', library: 'database', api: 'link' };

function SourceRow({ s }: { s: SourceHealth }) {
  const st = STATE[s.state];
  return (
    <div className="panel-row ast-src">
      <span className="ast-lead" aria-hidden><Icon name={KIND_ICON[s.kind]} size={16} /></span>
      <div className="ast-src-main">
        <div className="ast-src-title">
          <span className="ast-src-name">{s.id}</span>
          <Badge tone={st.tone}>{st.label}</Badge>
          {s.slotsLost > 0 && <Badge tone="warning">{s.slotsLost} slot{s.slotsLost === 1 ? '' : 's'} lost</Badge>}
        </div>
        <div className="text-micro mono truncate ast-dim" title={s.ref}>{s.kind} · {s.ref}</div>
        {s.detail && <div className="text-caption clamp ast-muted ast-src-detail" title={s.detail}>{s.detail}</div>}
      </div>
      <div className="ast-src-stats">
        <div className="ast-src-rate tabular-nums">{s.successRate === null ? '—' : `${Math.round(s.successRate * 100)}%`}</div>
        <div className="text-micro mono ast-dim">{s.calls ? `${s.ok}/${s.calls} reads` : 'no reads'}</div>
        {s.lastOkAt && <div className="text-micro mono ast-dim">ok {fmtRelative(s.lastOkAt)}</div>}
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
    <SectionCard title="Sources" icon="radar" flush delay={delay} style={{ marginBottom: 16 }}
      action={<span className={`mono ast-count${bad ? ' is-warn' : ''}`}>
        {bad ? `${bad} not working · ` : ''}{r.days} days
      </span>}>
      {r.sources.map((s) => <SourceRow key={s.id} s={s} />)}
      {bad > 0 && (
        <div className="panel-foot text-caption ast-muted">
          The agent looks for a replacement of a source that keeps failing; its proposal waits in "Waiting for you" with Apply / Discard.
        </div>
      )}
      {r.otherHosts.length > 0 && (
        <div className="panel-foot ast-hosts">
          <span className="text-overline">Blocked sites the agent tried</span>
          <div className="ast-chips">
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
