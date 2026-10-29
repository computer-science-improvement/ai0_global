import { memo } from 'react';
import type { MapAgentKind, MapUnit } from '../../api/map';
import { EYES, GRID, SPRITE_VIEWBOX, accessoryOf, filledCells, spriteOf } from '../../lib/map-avatar';

// Spec 056 FR-005: the pixel avatar — an 8×8 mirrored sprite from a hash of the handle, a palette colour, the kind's
// accessory (crown, quill, glasses...). Drawn as SVG rects: no images, no external assets.

const ACCESSORY_FILL = { gold: 'var(--color-warning)', ink: 'var(--color-ink)' } as const;

/** The sprite in cell units (the cell (x, y) is the square at x, y; the margin is -1 and GRID). Place it with a transform. */
export const PixelSprite = memo(function PixelSprite({ handle, kind }: { handle: string; kind: MapAgentKind }) {
  const sprite = spriteOf(handle);
  return (
    <g shapeRendering="crispEdges" aria-hidden>
      <g style={{ fill: sprite.color }}>
        {filledCells(sprite).map(([x, y]) => <rect key={`${x}.${y}`} x={x} y={y} width={1} height={1} />)}
      </g>
      <g style={{ fill: 'var(--color-canvas)' }}>
        {EYES.map(([x, y]) => <rect key={`e${x}`} x={x} y={y} width={1} height={1} />)}
      </g>
      {accessoryOf(kind).map((p) => (
        <rect key={`a${p.x}.${p.y}`} x={p.x} y={p.y} width={1} height={1} style={{ fill: ACCESSORY_FILL[p.tone] }} />
      ))}
    </g>
  );
});

/** Cell size inside a unit's ring on the map (the ring's inner radius is about 13.5). */
const CELL = 1.8;
const SHIFT = CELL - ((GRID + 2) * CELL) / 2;

/** The face inside a unit's ring on the map. */
export function UnitFace({ unit }: { unit: Pick<MapUnit, 'handle' | 'kind'> }) {
  return (
    <g transform={`translate(${SHIFT} ${SHIFT}) scale(${CELL})`}>
      <PixelSprite handle={unit.handle} kind={unit.kind} />
    </g>
  );
}

/** The avatar as its own small SVG, for the feed and the drawers. The emoji, when set, is a badge. */
export function Avatar({ handle, kind, emoji, size = 28, label }: { handle: string; kind: MapAgentKind; emoji?: string | null; size?: number; label?: string }) {
  return (
    <span className="map-avatar" style={{ width: size, height: size }} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <svg width={size} height={size} viewBox={SPRITE_VIEWBOX} aria-hidden>
        <PixelSprite handle={handle} kind={kind} />
      </svg>
      {emoji && <span className="map-avatar-emoji" style={{ fontSize: Math.max(11, Math.round(size * 0.36)) }}>{emoji}</span>}
    </span>
  );
}
