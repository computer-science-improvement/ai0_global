import { useMemo, type ReactNode } from 'react';
import type { MapSnapshot } from '../../api/map';
import type { MapLayout } from '../../lib/map-layout';
import { alertsByRef, roadKey, isWorking } from '../../lib/map-state';
import { showBuildingMeta, showUnitLabels } from '../../lib/map-view';
import { BuildingShape, HqShape, MapDefs, RoadShape, TerritoryShape, UnitShape } from './MapShapes';
import { UnitFace } from './MapAvatar';
import type { MapViewport } from './useMapViewport';

export type Selection =
  | { type: 'building'; ref: string }
  | { type: 'unit'; id: string }
  | { type: 'road'; key: string }
  | { type: 'alerts' };

export const sameSelection = (a: Selection | null, b: Selection | null): boolean =>
  !!a && !!b && a.type === b.type && (a.type === 'alerts' || JSON.stringify(a) === JSON.stringify(b));

export interface MapStageProps {
  snap: MapSnapshot;
  layout: MapLayout;
  viewport: MapViewport;
  selection: Selection | null;
  onSelect: (s: Selection | null) => void;
  /** Extra SVG layers (spec 056 FR-004 effects), drawn in world coordinates above everything. */
  overlay?: ReactNode;
  /** Per-building / per-unit / per-road extra layers (flares, floaters, sparks). */
  buildingFx?: (ref: string) => ReactNode;
  unitFx?: (id: string) => ReactNode;
  roadFx?: (key: string) => ReactNode;
}

/** The SVG of the network map: territories, headquarters, roads, buildings, units — inside a pan / zoom transform. */
export function MapStage({ snap, layout, viewport, selection, onSelect, overlay, buildingFx, unitFx, roadFx }: MapStageProps) {
  const { view, size, animated, dragging } = viewport;
  const beacons = useMemo(() => alertsByRef(snap.alerts), [snap.alerts]);

  return (
    <div
      ref={viewport.ref} className={`map-stage${dragging ? ' is-dragging' : ''}`} tabIndex={0} role="group"
      aria-label="Network map. Drag to pan, scroll or pinch to zoom, plus and minus to zoom, 0 to fit."
      {...viewport.handlers}
      onClick={(e) => {
        if (viewport.wasDrag()) return;
        if (!(e.target as Element).closest('.map-node, .map-road-group')) onSelect(null);
      }}
    >
      <svg className="map-svg" width={size.w || undefined} height={size.h || undefined}>
        <MapDefs />
        <g className={`map-world${animated ? ' is-animated' : ''}`} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          <rect x={-3000} y={-3000} width={9000} height={9000} fill="url(#map-dots)" opacity="0.35" pointerEvents="none" />
          {layout.territories.map((t) => <TerritoryShape key={t.id} t={t} />)}
          <HqShape rect={layout.hq} />

          {snap.roads.map((r) => {
            const a = layout.buildings[r.from];
            const b = layout.buildings[r.to];
            if (!a || !b) return null;
            const key = roadKey(r);
            return (
              <RoadShape key={key} road={r} from={a} to={b} selected={selection?.type === 'road' && selection.key === key}
                onSelect={() => onSelect({ type: 'road', key })}>
                {roadFx?.(key)}
              </RoadShape>
            );
          })}

          {snap.resources.map((r) => {
            const pos = layout.buildings[r.ref];
            if (!pos) return null;
            return (
              <BuildingShape key={r.ref} res={r} pos={pos} beacon={beacons.get(r.ref)} showMeta={showBuildingMeta(view.k)}
                selected={selection?.type === 'building' && selection.ref === r.ref} onSelect={() => onSelect({ type: 'building', ref: r.ref })}>
                {buildingFx?.(r.ref)}
              </BuildingShape>
            );
          })}

          {snap.units.map((u) => {
            const pos = layout.units[u.id];
            if (!pos) return null;
            return (
              <UnitShape key={u.id} unit={u} pos={pos} label={showUnitLabels(view.k)} face={<UnitFace unit={u} />}
                selected={selection?.type === 'unit' && selection.id === u.id} onSelect={() => onSelect({ type: 'unit', id: u.id })}>
                {unitFx?.(u.id)}
              </UnitShape>
            );
          })}
          {overlay}
        </g>
      </svg>
    </div>
  );
}

/** Whether any unit works right now (the page polls faster, the live dot pulses). */
export const anyWorking = (snap: Pick<MapSnapshot, 'units'> | undefined): boolean => !!snap?.units.some((u) => isWorking(u.state));
