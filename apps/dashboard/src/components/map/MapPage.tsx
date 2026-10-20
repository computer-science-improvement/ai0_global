import { useCallback, useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { MAP_KEY, mapApi, type MapEvent, type MapSnapshot } from '../../api/map';
import { EmptyState } from '../ui/primitives';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { layoutMap, type MapLayout } from '../../lib/map-layout';
import { pollInterval } from '../../lib/map-diff';
import { roadKey } from '../../lib/map-state';
import { AlertsDrawer, BuildingDrawer, InfraDrawer, RoadDrawer, UnitDrawer } from './MapDrawers';
import { FeedPanel, Legend, TopBar, ZoomControls } from './MapHud';
import { MapStage, anyWorking, sameSelection, type Selection } from './MapStage';
import { useFxRenderers } from './MapFx';
import { useMapLive } from './useMapLive';
import { useMapViewport } from './useMapViewport';
import './map.css';

/** Only the structure decides the layout: ids, homes, networks. A poll that changes states must not move anything. */
export function structureKey(s: Pick<MapSnapshot, 'networks' | 'resources' | 'units' | 'infra'>): string {
  return [
    (s.infra ?? []).map((i) => `${i.id}:${i.kind}`).sort().join(','),
    s.networks.map((n) => `${n.id}:${n.anchorRef ?? ''}`).sort().join(','),
    s.resources.map((r) => `${r.ref}:${r.groupId ?? ''}:${r.platform}`).sort().join(','),
    s.units.map((u) => `${u.id}:${u.homeRef ?? ''}:${u.parentId ?? ''}:${u.kind}`).sort().join(','),
  ].join('|');
}

export function MapPage() {
  const phone = useMediaQuery('(max-width: 639px)');
  const wide = useMediaQuery('(min-width: 1100px)');
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const q = useQuery({
    queryKey: MAP_KEY,
    queryFn: mapApi.snapshot,
    // 5 s while any unit works, 30 s otherwise, and none while the tab is hidden (FR-004). Coming back refetches at once.
    refetchInterval: (query) => pollInterval(query.state.data, typeof document !== 'undefined' && document.hidden),
    refetchIntervalInBackground: false,
    retry: false,
  });
  const snap = q.data;

  const layoutRef = useRef<{ key: string; layout: MapLayout } | null>(null);
  const layout = useMemo(() => {
    if (!snap) return null;
    const key = structureKey(snap);
    if (layoutRef.current?.key !== key) layoutRef.current = { key, layout: layoutMap(snap) };
    return layoutRef.current.layout;
  }, [snap]);

  const live = useMapLive(snap, reduced);
  const fx = useFxRenderers(live.fx, layout, snap?.roads ?? NO_ROADS);

  const viewport = useMapViewport(layout?.bounds ?? null, phone ? { top: 62, right: 0, bottom: 64, left: 0 } : { top: 76, right: 0, bottom: 20, left: 0 });

  const [selection, setSelection] = useState<Selection | null>(null);
  const [feedUser, setFeedUser] = useState<boolean | null>(null);
  const [legendUser, setLegendUser] = useState<boolean | null>(null);
  const feedOpen = feedUser ?? wide;
  const legendOpen = legendUser ?? wide;

  const select = useCallback((s: Selection | null) => {
    setSelection((cur) => (sameSelection(cur, s) ? null : s));
    if (s && phone) setFeedUser(false);
  }, [phone]);
  const close = useCallback(() => setSelection(null), []);

  const focusRef = useCallback((ref: string) => {
    const b = layout?.buildings[ref] ?? layout?.structures[ref];
    if (b) viewport.focusOn(b.x, b.y);
  }, [layout, viewport]);
  const pickInfra = useCallback((id: string) => { setSelection({ type: 'infra', id }); focusRef(id); }, [focusRef]);
  const pickBuilding = useCallback((ref: string) => { setSelection({ type: 'building', ref }); focusRef(ref); }, [focusRef]);

  const onPickEvent = useCallback((e: MapEvent) => {
    if (!snap || !layout) return;
    const u = e.agent ? snap.units.find((x) => x.handle === e.agent) : null;
    const pos = u ? layout.units[u.id] : e.ref ? layout.buildings[e.ref] : null;
    if (pos) viewport.focusOn(pos.x, pos.y, 1);
  }, [snap, layout, viewport]);

  if (q.isLoading) {
    return <div className="map-root"><div className="map-empty"><p className="text-caption" role="status" style={{ color: 'var(--color-ink-muted)' }}>Loading the map…</p></div></div>;
  }
  if (!snap || !layout) {
    return (
      <div className="map-root">
        <div className="map-empty">
          <EmptyState icon="map" title="The map is not available right now"
            note={q.error ? 'The server did not return the network snapshot. The rest of the dashboard still works.' : 'No data yet.'}
            action={<button type="button" className="btn-secondary" onClick={() => void q.refetch()}>Try again</button>} />
        </div>
      </div>
    );
  }

  const selectedBuilding = selection?.type === 'building' ? snap.resources.find((r) => r.ref === selection.ref) : undefined;
  const selectedUnit = selection?.type === 'unit' ? snap.units.find((u) => u.id === selection.id) : undefined;
  const selectedRoad = selection?.type === 'road' ? snap.roads.find((r) => roadKey(r) === selection.key) : undefined;
  const selectedInfra = selection?.type === 'infra' ? snap.infra?.find((i) => i.id === selection.id) : undefined;
  const drawerOpen = selection?.type === 'alerts' || !!selectedBuilding || !!selectedUnit || !!selectedRoad || !!selectedInfra;

  return (
    <div className="map-root">
      <MapStage snap={snap} layout={layout} viewport={viewport} selection={selection} onSelect={select}
        buildingFx={fx.buildingFx} unitFx={fx.unitFx} roadFx={fx.roadFx} isShaking={fx.isShaking} />

      {snap.resources.length === 0 && (
        <div className="map-empty">
          <EmptyState icon="map" title="Connect a channel"
            note="Your network appears here: a building for every channel and account, a unit for every agent that runs it."
            action={(
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                <Link to="/app/connections" search={{ section: 'telegram' }} className="btn-primary" style={{ textDecoration: 'none' }}>Open Connections</Link>
                <Link to="/app/chat" search={{ q: '/launch ' }} className="btn-secondary" style={{ textDecoration: 'none' }}>Launch a channel</Link>
              </div>
            )} />
        </div>
      )}

      <TopBar
        snap={snap} phone={phone} updatedAt={q.dataUpdatedAt || Date.now()} fast={anyWorking(snap)}
        bump={live.bump} alertsOpen={selection?.type === 'alerts'} feedOpen={feedOpen} legendOpen={legendOpen}
        onAlerts={() => select({ type: 'alerts' })}
        onFeed={() => { setFeedUser(!feedOpen); if (phone && !feedOpen) setSelection(null); }}
        onLegend={() => setLegendUser(!legendOpen)}
      />

      {feedOpen && !drawerOpen && (
        <FeedPanel events={snap.events} freshIds={live.freshIds} snap={snap} onPick={onPickEvent} onClose={() => setFeedUser(false)} />
      )}
      {legendOpen && !(phone && drawerOpen) && <Legend onClose={() => setLegendUser(false)} />}
      <ZoomControls view={viewport.view} onIn={viewport.zoomIn} onOut={viewport.zoomOut} onFit={viewport.fit} />

      {selection?.type === 'alerts' && <AlertsDrawer snap={snap} onClose={close} onShow={(ref) => { focusRef(ref); }} />}
      {selectedBuilding && <BuildingDrawer snap={snap} res={selectedBuilding} onClose={close} onPickUnit={(id) => setSelection({ type: 'unit', id })} onShow={focusRef} onPickInfra={pickInfra} />}
      {selectedUnit && <UnitDrawer snap={snap} unit={selectedUnit} onClose={close} onPickBuilding={pickBuilding} />}
      {selectedInfra && <InfraDrawer snap={snap} item={selectedInfra} onClose={close} onPickBuilding={pickBuilding} onShow={focusRef} />}
      {selectedRoad && <RoadDrawer snap={snap} road={selectedRoad} onClose={close} onPickBuilding={pickBuilding} />}
    </div>
  );
}

const NO_ROADS: MapSnapshot['roads'] = [];
