import type { CSSProperties } from 'react';

/**
 * A tiny bar chart of the last N values (a KPI's trend). Bars are scaled to the largest value, the last bar is full
 * accent, the others a tint; they grow in once. With nothing to draw (no values, or all zero) it shows a flat baseline.
 * Use it through `<StatTile spark={...} />` or on its own.
 */
export function Sparkline({ values, label, height = 40 }: {
  /** Oldest first. Negative values are drawn as zero. */
  values: number[];
  /** Accessible name; defaults to "Trend over the last N values". */
  label?: string;
  height?: number;
}) {
  const clean = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const max = Math.max(0, ...clean);
  return (
    <div className="spark" role="img" aria-label={label ?? `Trend over the last ${clean.length} values`} style={{ height }}>
      {clean.map((v, i) => (
        <span
          key={i}
          className={i === clean.length - 1 ? 'is-last' : undefined}
          style={{ height: `${max > 0 ? Math.max(6, Math.round((v / max) * 100)) : 6}%`, ['--i' as string]: i } as CSSProperties}
        />
      ))}
    </div>
  );
}
