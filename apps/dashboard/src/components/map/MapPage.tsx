import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMapSnapshot, type MapEvent, type MapSnapshot } from '../../api/map';
import { EmptyState } from '../ui/primitives';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { BUILDING_R, layoutMap, type MapLayout } from '../../lib/map-layout';
import { resourceTitle, roadKey } from '../../lib/map-state';
import { pastRoadCount } from '../../lib/map-links';
import { AlertsDrawer, BuildingDrawer, InfraDrawer, NetworkDrawer, RoadDrawer, UnitDrawer } from './MapDrawers';
import { LinkHint, LinkPopover } from './MapLinkMode';
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
  const q = useMapSnapshot();
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
  const [showPast, setShowPast] = useState(false);
  const feedOpen = feedUser ?? wide;
  const legendOpen = legendUser ?? wide;

  // Link mode (spec 058): click a building, then another one; the popover at the second offers what to do with the pair.
  const [linkMode, setLinkMode] = useState(false);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [linkTo, setLinkTo] = useState<string | null>(null);
  const pickForLink = useCallback((ref: string) => {
    if (!linkFrom || linkTo) { setLinkFrom(ref); setLinkTo(null); return; }
    if (ref === linkFrom) { setLinkFrom(null); return; }
    setLinkTo(ref);
  }, [linkFrom, linkTo]);
  const resetLink = useCallback(() => { setLinkFrom(null); setLinkTo(null); }, []);
  const toggleLinkMode = useCallback(() => {
    setLinkMode((on) => !on);
    setLinkFrom(null);
    setLinkTo(null);
    setSelection(null);
  }, []);
  useEffect(() => {
    if (!linkMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.modal-backdrop')) return;
      setLinkMode(false);
      setLinkFrom(null);
      setLinkTo(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [linkMode]);

  const select = useCallback((s: Selection | null) => {
    if (linkMode) {
      if (s?.type === 'building') pickForLink(s.ref);
      else if (!s) resetLink();
      return;
    }
    setSelection((cur) => (sameSelection(cur, s) ? null : s));
    if (s && phone) setFeedUser(false);
  }, [phone, linkMode, pickForLink, resetLink]);
  const close = useCallback(() => setSelection(null), []);
  const togglePast = useCallback(() => setShowPast((on) => !on), []);
  // Past links are drawn on request: when they are hidden (or a link was just broken), the drawer of a past road closes with its line.
  useEffect(() => {
    if (showPast) return;
    setSelection((cur) => (cur?.type === 'road' && snap?.roads.find((r) => roadKey(r) === cur.key)?.past ? null : cur));
  }, [showPast, snap]);

  const focusRef = useCallback((ref: string) => {
    const b = layout?.buildings[ref] ?? layout?.structures[ref];
    if (b) viewport.focusOn(b.x, b.y);
  }, [layout, viewport]);
  const pickInfra = useCallback((id: string) => { setSelection({ type: 'infra', id }); focusRef(id); }, [focusRef]);
  const pickBuilding = useCallback((ref: string) => { setSelection({ type: 'building', ref }); focusRef(ref); }, [focusRef]);
  const pickNetwork = useCallback((id: string) => setSelection({ type: 'network', id }), []);

  const onPickEvent = useCallback((e: MapEvent) => {
    if (!snap || !layout) return;
    const u = e.agent ? snap.units.find((x) => x.handle === e.agent) : null;
    const pos = u ? layout.units[u.id] : e.ref ? layout.buildings[e.ref] : null;
    if (pos) viewport.focusOn(pos.x, pos.y, 1);
  }, [snap, layout, viewport]);

  if (q.isLoading) {
    return <div className="map-root"><div className="map-empty"><p className="text-caption ink-muted" role="status">Loading the map…</p></div></div>;
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
  const selectedNetwork = selection?.type === 'network' ? snap.networks.find((n) => n.id === selection.id) : undefined;
  const drawerOpen = selection?.type === 'alerts' || !!selectedBuilding || !!selectedUnit || !!selectedRoad || !!selectedInfra || !!selectedNetwork;

  // The popover hangs under the second building, in the page's own pixels.
  const linkSpot = linkMode && linkFrom && linkTo ? layout.buildings[linkTo] : undefined;
  const { view, size } = viewport;
  const popX = linkSpot ? Math.min(Math.max(view.x + linkSpot.x * view.k, 138), Math.max(138, size.w - 138)) : 0;
  const popY = linkSpot ? Math.min(view.y + (linkSpot.y + BUILDING_R) * view.k, Math.max(80, size.h - 210)) : 0;
  const linkFirst = linkFrom ? snap.resources.find((r) => r.ref === linkFrom) : undefined;

  return (
    <div className="map-root">
      <MapStage snap={snap} layout={layout} viewport={viewport} onSelect={select} linkMode={linkMode}
        selection={linkMode ? (linkFrom ? { type: 'building', ref: linkFrom } : null) : selection}
        buildingFx={fx.buildingFx} unitFx={fx.unitFx} roadFx={fx.roadFx} isShaking={fx.isShaking} showPast={showPast} />

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
        showPast={showPast} pastCount={pastRoadCount(snap.roads)} onPast={togglePast} linkMode={linkMode} onLinkMode={toggleLinkMode}
        onAlerts={() => select({ type: 'alerts' })}
        onFeed={() => { setFeedUser(!feedOpen); if (phone && !feedOpen) setSelection(null); }}
        onLegend={() => setLegendUser(!legendOpen)}
      />

      {linkMode && <LinkHint first={linkFirst ? resourceTitle(linkFirst) : null} />}
      {linkMode && linkFrom && linkTo && (
        <LinkPopover snap={snap} a={linkFrom} b={linkTo} x={popX} y={popY} onDone={resetLink} onCancel={resetLink} />
      )}

      {feedOpen && !drawerOpen && (
        <FeedPanel events={snap.events} freshIds={live.freshIds} snap={snap} onPick={onPickEvent} onClose={() => setFeedUser(false)} />
      )}
      {legendOpen && !(phone && drawerOpen) && <Legend onClose={() => setLegendUser(false)} />}
      <ZoomControls view={viewport.view} onIn={viewport.zoomIn} onOut={viewport.zoomOut} onFit={viewport.fit} />

      {selection?.type === 'alerts' && <AlertsDrawer snap={snap} onClose={close} onShow={(ref) => { focusRef(ref); }} />}
      {selectedBuilding && <BuildingDrawer snap={snap} res={selectedBuilding} onClose={close} onPickUnit={(id) => setSelection({ type: 'unit', id })} onShow={focusRef} onPickInfra={pickInfra} onPickBuilding={pickBuilding} onPickNetwork={pickNetwork} />}
      {selectedNetwork && <NetworkDrawer snap={snap} network={selectedNetwork} onClose={close} onPickBuilding={pickBuilding} />}
      {selectedUnit && <UnitDrawer snap={snap} unit={selectedUnit} onClose={close} onPickBuilding={pickBuilding} />}
      {selectedInfra && <InfraDrawer snap={snap} item={selectedInfra} onClose={close} onPickBuilding={pickBuilding} onShow={focusRef} />}
      {selectedRoad && <RoadDrawer snap={snap} road={selectedRoad} onClose={close} onPickBuilding={pickBuilding} />}
    </div>
  );
}

const NO_ROADS: MapSnapshot['roads'] = [];
