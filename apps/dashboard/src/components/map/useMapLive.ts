import { useEffect, useRef, useState } from 'react';
import type { MapSnapshot } from '../../api/map';
import { EMPTY_DIFF, FRESH_MS, FX_LIFE_MS, diffSnapshots, type MapFx } from '../../lib/map-diff';

/**
 * Spec 056 FR-004: compares each new snapshot with the one before and hands out what is "live" for a moment — the
 * effects to play, the feed lines to highlight, the alert counter bump. The first snapshot plays nothing. With
 * `reduced` (prefers-reduced-motion) no effect is created at all; the feed highlight is a colour, so it stays.
 */

const NO_IDS: ReadonlySet<string> = new Set();
const BUMP_MS = 800;

export function useMapLive(snap: MapSnapshot | undefined, reduced: boolean) {
  const prev = useRef<MapSnapshot | null>(null);
  const [fx, setFx] = useState<MapFx[]>([]);
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(NO_IDS);
  const [bump, setBump] = useState(false);
  const freshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fxTimers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    if (!snap) return;
    const before = prev.current;
    prev.current = snap;
    const d = diffSnapshots(before, snap);
    if (d === EMPTY_DIFF) return;

    if (d.freshIds.length) {
      setFreshIds(new Set(d.freshIds));
      if (freshTimer.current) clearTimeout(freshTimer.current);
      freshTimer.current = setTimeout(() => setFreshIds(NO_IDS), FRESH_MS);
    }
    if (reduced) return;
    if (d.fx.length) {
      const ids = new Set(d.fx.map((f) => f.id));
      setFx((cur) => [...cur, ...d.fx]);
      const t = setTimeout(() => {
        fxTimers.current.delete(t);
        setFx((cur) => cur.filter((f) => !ids.has(f.id)));
      }, FX_LIFE_MS + 150);
      fxTimers.current.add(t);
    }
    if (d.alertBump) {
      setBump(true);
      if (bumpTimer.current) clearTimeout(bumpTimer.current);
      bumpTimer.current = setTimeout(() => setBump(false), BUMP_MS);
    }
  }, [snap, reduced]);

  useEffect(() => () => {
    if (freshTimer.current) clearTimeout(freshTimer.current);
    if (bumpTimer.current) clearTimeout(bumpTimer.current);
    fxTimers.current.forEach(clearTimeout);
  }, []);

  return { fx, freshIds, bump };
}
