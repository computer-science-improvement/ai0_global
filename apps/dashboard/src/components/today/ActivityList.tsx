// Spec 078 B1: Today's "Live activity": the six newest events of the network map's feed (the last 24 hours). The snapshot is
// the map's own query (`useMapSnapshot`), so the two pages share one cache entry and one timer. An event whose agent is a
// unit on the map shows that agent's pixel avatar; any other event shows the icon of its kind.

import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { SectionCard, EmptyState } from '../ui/primitives';
import { Icon } from '../ui/Icon';
import { Avatar } from '../map/MapAvatar';
import { useMapSnapshot } from '../../api/map';
import { EVENT_ICON, ago, isBadEvent, resourceTitle } from '../../lib/map-state';
import { recentEvents } from '../../lib/today';
import '../map/map.css';
import './today.css';

export function ActivityList({ now, delay }: { now: Date; delay?: number }) {
  const q = useMapSnapshot();
  const snap = q.data;
  const rows = useMemo(() => recentEvents(snap?.events), [snap]);
  const units = useMemo(() => new Map((snap?.units ?? []).map((u) => [u.handle, u])), [snap]);
  const titles = useMemo(() => new Map((snap?.resources ?? []).map((r) => [r.ref, resourceTitle(r)])), [snap]);
  const titleOf = (ref: string | null | undefined): string | null => (ref ? titles.get(ref) ?? ref.replace(/^[a-z]+:/, '') : null);

  return (
    <SectionCard title="Live activity" flush delay={delay} action={<Link to="/app/map" className="panel-link">Open map →</Link>}>
      {q.isError && !snap ? (
        <EmptyState icon="warning" title="Live activity is unavailable" note="The map feed did not answer. The page asks again in a moment." />
      ) : q.isLoading ? (
        <p className="text-caption ink-muted" role="status" style={{ margin: 0, padding: '28px 20px', textAlign: 'center' }}>Loading activity…</p>
      ) : rows.length === 0 ? (
        <EmptyState icon="radar" title="Nothing has happened in the last 24 hours" note="Runs, posts and decisions of your agents show up here as they happen." />
      ) : (
        rows.map((e) => {
          const unit = e.agent ? units.get(e.agent) : undefined;
          const bad = isBadEvent(e.kind);
          const where = [titleOf(e.ref), e.toRef ? `to ${titleOf(e.toRef)}` : null].filter(Boolean).join(' ');
          return (
            <div className={`panel-row act-row${bad ? ' is-bad' : ''}`} key={e.id}>
              {unit
                ? <Avatar handle={unit.handle} kind={unit.kind} emoji={unit.emoji} size={32} />
                : <span className={`act-icon${bad ? ' is-bad' : ''}`} aria-hidden="true"><Icon name={EVENT_ICON[e.kind] ?? 'info'} size={16} /></span>}
              <div className="act-main">
                <div className="act-text">
                  {e.agent && <span className="mono act-agent">@{e.agent}</span>}
                  {e.agent ? ' ' : ''}{e.text}
                </div>
                <div className="mono act-meta">{[where, ago(e.at, now)].filter(Boolean).join(' · ')}</div>
              </div>
            </div>
          );
        })
      )}
    </SectionCard>
  );
}
