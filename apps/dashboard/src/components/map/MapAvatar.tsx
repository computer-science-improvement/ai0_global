import type { MapUnit } from '../../api/map';
import { unitInitial } from '../../lib/map-state';

// Spec 056 FR-005 (T4 replaces this with the pixel sprites): the face inside a unit's ring.

export function UnitFace({ unit }: { unit: Pick<MapUnit, 'name' | 'handle' | 'emoji'> }) {
  return unit.emoji
    ? <text className="map-unit-emoji">{unit.emoji}</text>
    : <text className="map-unit-initial">{unitInitial(unit)}</text>;
}
