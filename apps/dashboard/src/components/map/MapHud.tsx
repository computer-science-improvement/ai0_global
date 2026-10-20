import { useEffect, useState } from 'react';
import { Icon } from '../ui/Icon';
import type { MapEvent, MapSnapshot } from '../../api/map';
import { UNIT_STATES } from '../../api/map';
import {
  EVENT_ICON, INFRA_META, MODE_META, PLATFORM_META, ROAD_META, STATE_META, ago, alertTone, alertTotal, isBadEvent, resourceTitle, usd,
} from '../../lib/map-state';
import { zoomPercent, type View } from '../../lib/map-view';
import { Avatar } from './MapAvatar';

// Spec 056 FR-003: the map's heads-up display — the top bar (minerals, runs, posts, what waits for you), the zoom
// buttons, the event feed and the legend.

/** Re-renders every `ms` so "12 s ago" stays true. */
export function useNow(ms = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export interface TopBarProps {
  snap: MapSnapshot;
  phone: boolean;
  /** When the snapshot was fetched (ms), for "updated 12 s ago". */
  updatedAt: number;
  fast: boolean;
  alertsOpen: boolean;
  feedOpen: boolean;
  legendOpen: boolean;
  /** The number of things that wait for you just went up (the counter bumps). */
  bump?: boolean;
  onAlerts: () => void;
  onFeed: () => void;
  onLegend: () => void;
}

export function TopBar({ snap, phone, updatedAt, fast, alertsOpen, feedOpen, legendOpen, bump, onAlerts, onFeed, onLegend }: TopBarProps) {
  const now = useNow(1000);
  const b = snap.budget;
  const total = alertTotal(snap.alerts);
  const critical = snap.alerts.some((a) => alertTone(a.kind) === 'danger');
  const tone = b.blocking || (b.pct ?? 0) >= 90 ? 'is-danger' : (b.pct ?? 0) >= 70 ? 'is-warning' : '';
  const stale = now.getTime() - updatedAt > 90_000;
  return (
    <div className="map-hud map-topbar" role="toolbar" aria-label="Network map status">
      <h1><Icon name="map" size={18} /><span className={phone ? 'sr-only' : undefined}>Network map</span></h1>
      <span className="map-sep map-hide-phone" />
      <div className="map-stat" title={b.blocking ? 'A spend cap blocks AI calls' : 'AI spend today against the daily cap'}>
        <Icon name="gem" size={15} />
        <span><b style={{ fontWeight: 600 }}>{usd(b.spentUsd)}</b>{b.capUsd != null && <span className="map-stat-label"> / {usd(b.capUsd)}</span>}</span>
        {b.capUsd != null && <span className={`map-meter ${tone}`} role="progressbar" aria-label="Spend today" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, b.pct ?? 0)}><i style={{ width: `${Math.min(100, b.pct ?? 0)}%` }} /></span>}
      </div>
      <div className="map-stat map-hide-phone map-hide-narrow" title="Agent runs started today"><Icon name="play" size={14} /><span>{snap.totals.runsToday}</span><span className="map-stat-label">runs</span></div>
      <div className="map-stat map-hide-phone map-hide-narrow" title="Posts published today"><Icon name="send" size={14} /><span>{snap.totals.postsToday}</span><span className="map-stat-label">posts</span></div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="map-stat map-hide-phone" title={`Updated ${ago(new Date(updatedAt).toISOString(), now)}. The map refreshes every ${fast ? '5' : '30'} seconds.`}>
          <span className={`map-live-dot${stale ? ' is-stale' : ''}${fast && !stale ? ' is-fast' : ''}`} />
          <span className="map-stat-label map-hide-narrow">{stale ? 'Offline' : `Updated ${ago(new Date(updatedAt).toISOString(), now)}`}</span>
        </span>
        <button type="button" className={`map-alerts-btn${total ? (critical ? ' has-critical' : ' has-alerts') : ''}${bump ? ' is-bump' : ''}`} aria-pressed={alertsOpen}
          aria-label={total ? `${total} ${total === 1 ? 'thing waits' : 'things wait'} for you. Open the list.` : 'Nothing waits for you'} onClick={onAlerts}
          title={total ? 'Things that wait for you' : 'Nothing waits for you'}>
          <Icon name="bell" size={15} />{total}
        </button>
        <button type="button" className="map-icon-btn" aria-pressed={feedOpen} aria-label="Activity feed" title="Activity feed" onClick={onFeed}><Icon name="logs" size={16} /></button>
        <button type="button" className="map-icon-btn" aria-pressed={legendOpen} aria-label="Legend" title="Legend" onClick={onLegend}><Icon name="info" size={16} /></button>
      </div>
    </div>
  );
}

export function ZoomControls({ view, onIn, onOut, onFit }: { view: View; onIn: () => void; onOut: () => void; onFit: () => void }) {
  return (
    <div className="map-hud map-zoom" role="group" aria-label="Zoom">
      <button type="button" className="map-icon-btn" aria-label="Zoom in" title="Zoom in (+)" onClick={onIn}><Icon name="zoom-in" size={16} /></button>
      <button type="button" className="map-icon-btn" aria-label="Zoom out" title="Zoom out (−)" onClick={onOut}><Icon name="zoom-out" size={16} /></button>
      <button type="button" className="map-icon-btn" aria-label="Fit the whole map" title="Fit (0)" onClick={onFit}><Icon name="fit" size={16} /></button>
      <span className="map-zoom-pct" aria-live="off">{zoomPercent(view)}</span>
    </div>
  );
}

export interface FeedProps {
  events: MapEvent[];
  /** The ids that arrived with the last poll (highlighted for a moment). */
  freshIds: ReadonlySet<string>;
  snap: Pick<MapSnapshot, 'resources' | 'units'>;
  onPick: (e: MapEvent) => void;
  onClose: () => void;
}

/** The unit's avatar with the kind of event as a small badge; an event with no unit on the map shows the event's icon alone. */
function FeedAvatar({ event, unit }: { event: MapEvent; unit?: MapSnapshot['units'][number] }) {
  const bad = isBadEvent(event.kind);
  const badge = (
    <span className="map-feed-badge" style={{ color: bad ? 'var(--color-danger)' : 'var(--color-ink-muted)' }}><Icon name={EVENT_ICON[event.kind]} size={unit ? 9 : 14} strokeWidth={unit ? 2.8 : 2} /></span>
  );
  if (!unit) return <span className="map-feed-icon" style={{ color: bad ? 'var(--color-danger)' : 'var(--color-ink-muted)' }}>{badge}</span>;
  return <span className="map-feed-avatar"><Avatar handle={unit.handle} kind={unit.kind} size={28} />{badge}</span>;
}

export function FeedPanel({ events, freshIds, snap, onPick, onClose }: FeedProps) {
  const now = useNow(15_000);
  const titles = new Map(snap.resources.map((r) => [r.ref, resourceTitle(r)]));
  const units = new Map(snap.units.map((u) => [u.handle, u]));
  return (
    <section className="map-hud map-feed" aria-label="Activity feed">
      <div className="map-drawer-grip" aria-hidden />
      <div className="map-feed-head">
        <span>Activity <span className="map-stat-label">last 24 h</span></span>
        <button type="button" className="map-icon-btn" style={{ width: 28, height: 28 }} aria-label="Hide the feed" onClick={onClose}><Icon name="x" size={14} /></button>
      </div>
      {events.length === 0
        ? <p className="text-caption" style={{ margin: 0, padding: 16, color: 'var(--color-ink-muted)' }}>Nothing has happened in the last 24 hours.</p>
        : (
          <ul className="map-feed-list">
            {events.map((e) => (
              <li key={e.id}>
                <button type="button" className={`map-feed-row${isBadEvent(e.kind) ? ' is-bad' : ''}${freshIds.has(e.id) ? ' is-new' : ''}`} onClick={() => onPick(e)}>
                  <FeedAvatar event={e} unit={e.agent ? units.get(e.agent) : undefined} />
                  <span style={{ minWidth: 0 }}>
                    <span className="map-feed-text">{e.agent && <b style={{ fontWeight: 600 }}>@{e.agent} </b>}{e.text}</span>
                    <span className="map-feed-meta block">{[e.ref ? titles.get(e.ref) ?? e.ref : null, ago(e.at, now)].filter(Boolean).join(' · ')}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

export function Legend({ onClose }: { onClose: () => void }) {
  return (
    <section className="map-hud map-legend" aria-label="Legend">
      <h2>
        <span>Legend</span>
        <button type="button" className="map-icon-btn" style={{ width: 24, height: 24 }} aria-label="Hide the legend" onClick={onClose}><Icon name="x" size={12} /></button>
      </h2>
      <div className="map-legend-sub" style={{ marginTop: 0 }}>Agent state (the ring)</div>
      <div className="map-legend-grid">
        {UNIT_STATES.map((s) => (
          <span key={s} className="map-legend-item" title={STATE_META[s].help}>
            <span style={{ width: 16, height: 16, borderRadius: '50%', border: `2px solid ${STATE_META[s].color}`, display: 'grid', placeItems: 'center', color: STATE_META[s].color, flex: 'none' }}>
              <Icon name={STATE_META[s].icon} size={8} strokeWidth={3} />
            </span>
            {STATE_META[s].label}
          </span>
        ))}
      </div>
      <div className="map-legend-sub">Roads</div>
      <div className="map-legend-grid">
        {(Object.keys(ROAD_META) as Array<keyof typeof ROAD_META>).map((k) => (
          <span key={k} className="map-legend-item">
            <svg width="26" height="8" aria-hidden><line x1="1" y1="4" x2="25" y2="4" strokeWidth="2.4" strokeLinecap="round" strokeDasharray={ROAD_META[k].dash || undefined} style={{ stroke: ROAD_META[k].color }} /></svg>
            {ROAD_META[k].label}
          </span>
        ))}
      </div>
      <div className="map-legend-sub">Buildings</div>
      <div className="map-legend-grid">
        <span className="map-legend-item"><i style={{ width: 12, height: 12, borderRadius: 4, border: '2.5px solid var(--color-accent)' }} />Connected</span>
        <span className="map-legend-item"><i style={{ width: 12, height: 12, borderRadius: 4, border: '2.5px solid var(--color-warning)' }} />Needs attention</span>
        <span className="map-legend-item"><i style={{ width: 12, height: 12, borderRadius: 4, border: '2.5px solid var(--color-danger)' }} />Broken</span>
        <span className="map-legend-item"><i style={{ width: 12, height: 12, borderRadius: 4, border: '1px dashed var(--color-ink-dim)', background: 'repeating-linear-gradient(45deg, var(--color-ink-dim) 0 1px, transparent 1px 4px)' }} />Paused</span>
        <span className="map-legend-item" style={{ gridColumn: '1 / -1' }}>
          <span style={{ width: 14, height: 14, borderRadius: '50%', background: 'var(--color-warning)', color: 'var(--color-on-accent)', fontSize: 9, fontWeight: 700, display: 'grid', placeItems: 'center', flex: 'none' }}>2</span>
          Beacon: something waits for you here
        </span>
        <span className="map-legend-item" style={{ gridColumn: '1 / -1', color: 'var(--color-ink-muted)' }}>
          {Object.values(PLATFORM_META).map((p) => <Icon key={p.label} name={p.icon} size={12} />)}
        </span>
      </div>
      <div className="map-legend-sub">Resource mode (the pill)</div>
      <div className="map-legend-grid">
        {Object.values(MODE_META).map((m) => (
          <span key={m.label} className="map-legend-item" title={m.help}>
            <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: '0.08em', color: m.color, border: `1px solid ${m.color}`, borderRadius: 7, padding: '1px 5px', flex: 'none' }}>{m.short}</span>
            {m.label}
          </span>
        ))}
      </div>
      <div className="map-legend-sub">Connections</div>
      <div className="map-legend-grid">
        {Object.values(INFRA_META).map((m) => (
          <span key={m.label} className="map-legend-item"><Icon name={m.icon} size={12} />{m.label}</span>
        ))}
        <span className="map-legend-item" style={{ gridColumn: '1 / -1' }}>
          <svg width="26" height="8" aria-hidden><line x1="1" y1="4" x2="25" y2="4" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="1 5" style={{ stroke: 'var(--color-ink-muted)' }} /></svg>
          A bot publishes / a session reads (on select)
        </span>
      </div>
    </section>
  );
}
