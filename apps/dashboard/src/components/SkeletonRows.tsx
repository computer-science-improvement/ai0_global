// Loading placeholder: a few shimmering rows. Inside a panel (`flush` for a flush one) it stands in for the list that is
// loading, so the panel keeps its height instead of jumping. The shimmer is a CSS animation, so the global
// reduced-motion block (index.css) calms it. Local to the C6 pages (spec 078); worth promoting to ui/.

import './skeleton-rows.css';

export function SkeletonRows({ rows = 3, height = 52, flush = false, label = 'Loading' }: {
  rows?: number;
  /** Height of one row in px. */
  height?: number;
  /** Inside a `SectionCard flush`: pad like a `.panel-row`. */
  flush?: boolean;
  /** Accessible name of the status region. */
  label?: string;
}) {
  return (
    <div className={`sk-rows${flush ? ' is-flush' : ''}`} role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="sk-row" style={{ height, animationDelay: `${i * 80}ms` }} />
      ))}
    </div>
  );
}
