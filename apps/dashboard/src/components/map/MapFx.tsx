import { useMemo, type ReactNode } from 'react';
import { Icon } from '../ui/Icon';
import type { MapSnapshot } from '../../api/map';
import { BUILDING_R, UNIT_R, roadGeometry, type MapLayout } from '../../lib/map-layout';
import { fxForBuilding, fxForRoad, fxForUnit, type MapFx } from '../../lib/map-diff';
import { STATE_META } from '../../lib/map-state';

// Spec 056 FR-004: the one-off effects on the map. Each lives for about a second, is created only for a new event or a
// state change (never on the first load), has no pointer events and is switched off by prefers-reduced-motion.

export interface FxRenderers {
  unitFx: (id: string) => ReactNode;
  buildingFx: (ref: string) => ReactNode;
  roadFx: (key: string) => ReactNode;
  /** The unit shakes once (a class on its body). */
  isShaking: (id: string) => boolean;
}

export function useFxRenderers(fx: readonly MapFx[], layout: MapLayout | null, roads: MapSnapshot['roads']): FxRenderers {
  return useMemo(() => {
    if (!layout) return { unitFx: () => null, buildingFx: () => null, roadFx: () => null, isShaking: () => false };
    const roadEnds = new Map<string, { from: { x: number; y: number }; to: { x: number; y: number } }>();
    const endsOf = (key: string) => {
      if (!roadEnds.size) {
        for (const r of roads) {
          const a = layout.buildings[r.from];
          const b = layout.buildings[r.to];
          if (a && b) roadEnds.set(`${r.from}>${r.to}>${r.kind}`, { from: a, to: b });
        }
      }
      return roadEnds.get(key);
    };
    const shaking = new Set(fx.filter((f) => f.kind === 'shake').map((f) => ('unitId' in f ? f.unitId : '')));

    return {
      isShaking: (id) => shaking.has(id),
      unitFx: (id) => {
        const mine = fxForUnit(fx, id);
        if (!mine.length) return null;
        const at = layout.units[id];
        return mine.map((f) => {
          if (f.kind === 'pulse') {
            return <circle key={f.id} r={UNIT_R + 2} className="map-fx map-fx-pulse" style={{ stroke: STATE_META[f.to].color }} />;
          }
          if (f.kind === 'spark') {
            return (
              <g key={f.id} transform={`translate(0 ${-UNIT_R - 6})`} className="map-fx map-fx-rise" style={{ color: STATE_META.writing.color }}>
                <g transform="translate(-6 -6)"><Icon name="pen" size={12} strokeWidth={2.4} /></g>
                <circle cx={-9} cy={-2} r={1.6} className="map-fx-dot" /><circle cx={9} cy={-5} r={1.2} className="map-fx-dot" />
              </g>
            );
          }
          if (f.kind === 'plane') {
            const to = layout.buildings[f.ref];
            if (!at || !to) return null;
            return (
              <g key={f.id} className="map-fx map-fx-fly" style={{ ['--dx' as string]: `${to.x - at.x}px`, ['--dy' as string]: `${to.y - at.y}px`, color: STATE_META.publishing.color }}>
                <g transform="translate(-7 -7)"><Icon name="send" size={14} strokeWidth={2.4} /></g>
              </g>
            );
          }
          return null;
        });
      },
      buildingFx: (ref) => {
        const mine = fxForBuilding(fx, ref);
        if (!mine.length) return null;
        return mine.map((f) => {
          if (f.kind === 'flare') {
            return (
              <g key={f.id}>
                <circle r={BUILDING_R + 2} className="map-fx map-fx-flare" />
                <text y={-BUILDING_R - 4} className="map-fx map-fx-float">+{f.count} {f.count === 1 ? 'post' : 'posts'}</text>
              </g>
            );
          }
          if (f.kind === 'alert') return <circle key={f.id} r={BUILDING_R + 6} className="map-fx map-fx-alert" />;
          return null;
        });
      },
      roadFx: (key) => {
        const mine = fxForRoad(fx, key);
        const ends = mine.length ? endsOf(key) : undefined;
        if (!mine.length || !ends) return null;
        const d = roadGeometry(ends.from, ends.to).d;
        return mine.map((f) => (
          <circle key={f.id} r={4.5} className="map-fx map-fx-travel" style={{ fill: 'var(--color-tg-link)' }}>
            <animateMotion dur="1s" fill="freeze" path={d} calcMode="spline" keySplines="0.4 0 0.2 1" keyTimes="0;1" />
          </circle>
        ));
      },
    } satisfies FxRenderers;
  }, [fx, layout, roads]);
}
