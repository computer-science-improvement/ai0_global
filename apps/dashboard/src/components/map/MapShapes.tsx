import type { KeyboardEvent, ReactNode } from 'react';
import { Icon } from '../ui/Icon';
import type { MapResource, MapRoad, MapUnit } from '../../api/map';
import { BUILDING_R, UNIT_R, hexPoints, roadGeometry, type PlacedBuilding, type PlacedUnit, type Rect, type Territory } from '../../lib/map-layout';
import {
  HEALTH_META, PLATFORM_META, ROAD_META, STATE_META, compactNumber, isDormant, isWorking, kindLabel, resourceTitle, stateLine, type AlertTone,
} from '../../lib/map-state';

// Spec 056 FR-003: the SVG pieces of the network map — territories, headquarters, buildings, units and roads.
// Colours are CSS variables only. Every interactive piece is a focusable button-like group.

const TINTS = ['var(--color-accent)', 'var(--color-tg-link)', 'var(--color-chart-5)', 'var(--color-chart-6)', 'var(--color-warning)', 'var(--color-chart-8)'];
export const tintOf = (i: number): string => TINTS[i % TINTS.length];

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Enter / Space activates a focusable group the way a button does. */
export function onActivate(fn: () => void) {
  return (e: KeyboardEvent<SVGElement>) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
  };
}

export function MapDefs() {
  return (
    <defs>
      <pattern id="map-dots" width="28" height="28" patternUnits="userSpaceOnUse">
        <circle cx="2" cy="2" r="1.1" style={{ fill: 'var(--color-hairline-strong)' }} opacity="0.55" />
      </pattern>
      <pattern id="map-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="7" style={{ stroke: 'var(--color-ink-dim)' }} strokeWidth="2.4" opacity="0.55" />
      </pattern>
      <linearGradient id="map-plate" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style={{ stopColor: 'var(--color-surface-3)' }} />
        <stop offset="1" style={{ stopColor: 'var(--color-surface-1)' }} />
      </linearGradient>
      <linearGradient id="map-hq" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style={{ stopColor: 'var(--color-surface-3)' }} />
        <stop offset="1" style={{ stopColor: 'var(--color-surface-2)' }} />
      </linearGradient>
      {(['promo', 'repost', 'duplicate'] as const).map((k) => (
        <marker key={k} id={`map-arrow-${k}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
          <path d="M 1 1 L 9 5 L 1 9 z" style={{ fill: ROAD_META[k].color }} />
        </marker>
      ))}
    </defs>
  );
}

/** A territory: a rounded region with a name tag and corner ticks. */
export function TerritoryShape({ t }: { t: Territory }) {
  const tint = t.kind === 'frontier' ? 'var(--color-ink-dim)' : tintOf(t.tint);
  const tick = 16;
  return (
    <g style={{ ['--map-tint' as string]: tint }} aria-label={`${t.name}, ${t.refs.length} ${t.refs.length === 1 ? 'resource' : 'resources'}`} role="group">
      <rect x={t.x} y={t.y} width={t.w} height={t.h} rx={30}
        style={{ fill: `color-mix(in srgb, ${tint} 5%, var(--color-surface-1))`, stroke: `color-mix(in srgb, ${tint} 38%, transparent)` }}
        strokeWidth="1.5" strokeDasharray={t.kind === 'frontier' ? '3 7' : undefined} opacity="0.92" />
      <rect x={t.x} y={t.y} width={t.w} height={t.h} rx={30} fill="url(#map-dots)" opacity="0.5" pointerEvents="none" />
      {[[t.x + 10, t.y + 10, 1, 1], [t.x + t.w - 10, t.y + 10, -1, 1], [t.x + 10, t.y + t.h - 10, 1, -1], [t.x + t.w - 10, t.y + t.h - 10, -1, -1]].map(([x, y, sx, sy], i) => (
        <path key={i} d={`M ${x} ${y + sy * tick} L ${x} ${y} L ${x + sx * tick} ${y}`} fill="none" strokeWidth="2" strokeLinecap="round" style={{ stroke: tint }} opacity="0.6" />
      ))}
      <text x={t.x + 28} y={t.y + 31} className="map-territory-name">{clip(t.name, 28)}</text>
      <text x={t.x + t.w - 28} y={t.y + 31} textAnchor="end" className="map-territory-count">{t.refs.length} {t.refs.length === 1 ? 'resource' : 'resources'}</text>
    </g>
  );
}

/** The headquarters: the system agents' hall at the top centre. */
export function HqShape({ rect }: { rect: Rect }) {
  const { x, y, w, h } = rect;
  const cx = x + w / 2;
  const m = 14; // battlement size
  const top = `M ${x + 20} ${y + h} L ${x + 20} ${y + 24} Q ${x + 20} ${y + 12} ${x + 32} ${y + 12} L ${cx - 70} ${y + 12} L ${cx - 54} ${y} L ${cx + 54} ${y} L ${cx + 70} ${y + 12} L ${x + w - 32} ${y + 12} Q ${x + w - 20} ${y + 12} ${x + w - 20} ${y + 24} L ${x + w - 20} ${y + h} Z`;
  return (
    <g role="group" aria-label="Headquarters: the system agents">
      <path d={top} fill="url(#map-hq)" strokeWidth="1.5" style={{ stroke: 'var(--color-hairline-strong)' }} strokeLinejoin="round" />
      <path d={top} fill="url(#map-dots)" opacity="0.5" pointerEvents="none" />
      {[-1, 1].map((s) => (
        <path key={s} d={`M ${cx + s * 88} ${y + 12} l 0 -${m / 2} l ${s * 8} 0 l 0 ${m / 2}`} fill="none" strokeWidth="1.5" style={{ stroke: 'var(--color-hairline-strong)' }} />
      ))}
      <text x={cx} y={y + 36} textAnchor="middle" className="map-hq-name">Headquarters</text>
    </g>
  );
}

function PlatformGlyph({ platform, size = 22, tint }: { platform: MapResource['platform']; size?: number; tint: string }) {
  return (
    <g transform={`translate(${-size / 2} ${-size / 2 - 3})`} style={{ color: tint }}>
      <Icon name={PLATFORM_META[platform].icon} size={size} strokeWidth={1.9} />
    </g>
  );
}

export interface BuildingProps {
  res: MapResource;
  pos: PlacedBuilding;
  /** What waits for the owner here (the beacon). */
  beacon?: { count: number; tone: AlertTone };
  selected: boolean;
  showMeta: boolean;
  onSelect: () => void;
  /** Extra layers drawn inside the building's group (flares, floaters). */
  children?: ReactNode;
}

export function BuildingShape({ res, pos, beacon, selected, showMeta, onSelect, children }: BuildingProps) {
  const meta = PLATFORM_META[res.platform];
  const health = HEALTH_META[res.health];
  const title = resourceTitle(res);
  const label = `${title}, ${meta.label}${res.followers != null ? `, ${compactNumber(res.followers)} followers` : ''}, ${health.label.toLowerCase()}${res.paused ? ', paused' : ''}${beacon ? `, ${beacon.count} waiting for you` : ''}`;
  const beaconColor = beacon?.tone === 'danger' ? 'var(--color-danger)' : 'var(--color-warning)';
  return (
    <g transform={`translate(${pos.x} ${pos.y})`} className={`map-node map-building${selected ? ' is-selected' : ''}`} data-ref={res.ref}
      role="button" tabIndex={0} aria-label={label} aria-pressed={selected} onClick={onSelect} onKeyDown={onActivate(onSelect)}>
      <title>{label}</title>
      {beacon && <circle r={BUILDING_R + 6} className="map-beacon" style={{ stroke: beaconColor }} />}
      {selected && <circle r={BUILDING_R + 9} className="map-selected-ring" />}
      <circle r={BUILDING_R + 8} className="map-focus-ring" />
      <g className="map-plate">
        <polygon points={hexPoints(BUILDING_R + 2)} fill="url(#map-plate)" strokeWidth={res.health === 'unknown' ? 1.5 : 3} strokeLinejoin="round" style={{ stroke: health.color }} />
        {res.paused && <polygon points={hexPoints(BUILDING_R + 2)} fill="url(#map-hatch)" pointerEvents="none" />}
        <PlatformGlyph platform={res.platform} tint={res.paused ? 'var(--color-ink-dim)' : meta.tint} />
        {pos.anchor && <circle cx={0} cy={BUILDING_R - 8} r={2.5} style={{ fill: meta.tint }} opacity="0.9" />}
      </g>
      {beacon && (
        <g transform={`translate(${BUILDING_R - 4} ${-BUILDING_R + 4})`}>
          <circle r={9.5} style={{ fill: beaconColor }} />
          <text className="map-badge-text">{beacon.count > 9 ? '9+' : beacon.count}</text>
        </g>
      )}
      {res.paused && (
        <g transform={`translate(${-BUILDING_R + 4} ${-BUILDING_R + 4})`} style={{ color: 'var(--color-ink)' }}>
          <circle r={8.5} style={{ fill: 'var(--color-surface-3)', stroke: 'var(--color-hairline-strong)' }} />
          <g transform="translate(-5 -5)"><Icon name="pause" size={10} strokeWidth={2.4} /></g>
        </g>
      )}
      <text y={BUILDING_R + 17} textAnchor="middle" className="map-building-title">{clip(title, 20)}</text>
      {showMeta && (res.followers != null || res.postsToday > 0) && (
        <text y={BUILDING_R + 31} textAnchor="middle" className="map-building-meta">
          {[res.followers != null ? `${compactNumber(res.followers)} followers` : null, res.postsToday > 0 ? `${res.postsToday} today` : null].filter(Boolean).join(' · ')}
        </text>
      )}
      {children}
    </g>
  );
}

export interface UnitProps {
  unit: MapUnit;
  pos: PlacedUnit;
  selected: boolean;
  /** Draw the @handle under the unit (orchestrators and headquarters; role children only on hover). */
  label: boolean;
  onSelect: () => void;
  /** The face inside the ring (the avatar). */
  face: ReactNode;
  /** Shakes once (a new failure, spec 056 FR-004). */
  shaking?: boolean;
  children?: ReactNode;
}

/** A unit: its face in a ring coloured by its state, a tiny state glyph, a bob while it works. */
export function UnitShape({ unit, pos, selected, label, onSelect, face, shaking, children }: UnitProps) {
  const st = STATE_META[unit.state];
  const text = `@${unit.handle}, ${kindLabel(unit.kind)}, ${stateLine(unit)}${unit.level != null ? `, level ${unit.level}` : ''}`;
  const isChild = unit.parentId != null;
  return (
    <g transform={`translate(${pos.x} ${pos.y})`} data-unit={unit.id}
      className={`map-node map-unit${isDormant(unit.state) ? ' is-dormant' : ''}${isWorking(unit.state) ? ' is-working' : ''}${shaking ? ' is-shaking' : ''}${selected ? ' is-selected' : ''}`}
      role="button" tabIndex={0} aria-label={text} aria-pressed={selected} onClick={onSelect} onKeyDown={onActivate(onSelect)}>
      <title>{text}</title>
      <circle r={UNIT_R + 6} className="map-focus-ring" />
      {selected && <circle r={UNIT_R + 6} className="map-selected-ring" />}
      <g className="map-unit-body">
        <g className="map-unit-bob" data-fx-body>
          <circle r={UNIT_R + 1.5} className="map-unit-ring" fill="none" strokeWidth={2.6} style={{ stroke: st.color }} strokeDasharray={unit.state === 'paused' ? '3 3' : undefined} />
          <circle r={UNIT_R - 0.5} style={{ fill: 'var(--color-surface-2)' }} />
          {face}
        </g>
        <g transform={`translate(${UNIT_R - 3} ${UNIT_R - 3})`} style={{ color: 'var(--color-canvas)' }}>
          <circle r={6.5} style={{ fill: st.color }} />
          <g transform="translate(-4.5 -4.5)"><Icon name={st.icon} size={9} strokeWidth={2.8} /></g>
        </g>
      </g>
      {label && <text y={UNIT_R + 15} className={`map-unit-label${isChild ? ' is-child' : ''}`}>@{clip(unit.handle, 16)}</text>}
      {children}
    </g>
  );
}

export interface RoadProps {
  road: MapRoad;
  from: { x: number; y: number };
  to: { x: number; y: number };
  selected: boolean;
  onSelect: () => void;
  children?: ReactNode;
}

export function RoadShape({ road, from, to, selected, onSelect, children }: RoadProps) {
  const meta = ROAD_META[road.kind];
  const g = roadGeometry(from, to);
  const width = 1.6 + Math.min(3.2, Math.log2(1 + road.count30d) * 0.7);
  const label = `${meta.label} road, ${road.count30d} in 30 days`;
  return (
    <g className={`map-road-group${selected ? ' is-selected' : ''}`} role="button" tabIndex={0} aria-label={label} aria-pressed={selected}
      data-road={`${road.from}>${road.to}>${road.kind}`} onClick={onSelect} onKeyDown={onActivate(onSelect)} style={{ cursor: 'pointer', outline: 'none' }}>
      <title>{label}</title>
      <path d={g.d} className="map-road-hit" />
      <path d={g.d} className="map-road" strokeWidth={selected ? width + 1.2 : width} strokeDasharray={meta.dash || undefined}
        style={{ stroke: meta.color }} markerEnd={`url(#map-arrow-${road.kind})`} />
      {children}
    </g>
  );
}
