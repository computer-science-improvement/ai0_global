// Spec 026 FR-005: the live proof strip under the hero headline. Every number comes
// from GET /api/landing/pulse; tiles with a zero value are hidden (lib/landing-view
// proofTiles), and the caller hides the whole strip when the pulse fails. Each tile
// has a "?" button (click/tap, not hover-only) that reveals how the number is counted.
import { useId, useState, type JSX } from 'react';
import type { LandingPulse } from '../../api/landing';
import { proofTiles } from '../../lib/landing-view';

export function ProofStrip({ pulse }: { pulse: LandingPulse | undefined }): JSX.Element | null {
  const tiles = proofTiles(pulse);
  const [open, setOpen] = useState<string | null>(null);
  const baseId = useId();
  if (tiles.length === 0) return null;

  const openTile = tiles.find((t) => t.key === open);
  return (
    <div className="lp-proof" aria-label="Live numbers from the network">
      <ul className="lp-proof-tiles">
        {tiles.map((t) => {
          const id = `${baseId}-${t.key}`;
          const expanded = open === t.key;
          return (
            <li key={t.key} className={`lp-proof-tile${expanded ? ' is-open' : ''}`}>
              <span className="lp-proof-value">{t.value}</span>
              <span className="lp-proof-label">
                {t.label}
                <button
                  type="button"
                  className="lp-proof-help"
                  aria-expanded={expanded}
                  aria-controls={`${baseId}-def`}
                  aria-label={`How “${t.label}” is counted`}
                  onClick={() => setOpen(expanded ? null : t.key)}
                  id={id}
                >?</button>
              </span>
            </li>
          );
        })}
      </ul>
      <p id={`${baseId}-def`} className="lp-proof-def" aria-live="polite" hidden={!openTile}>
        {openTile?.definition}
      </p>
      {pulse?.stale && <p className="lp-proof-note">Numbers from the last successful update.</p>}

      <style>{`
        .lp-proof { width: 100%; max-width: 860px; margin: var(--space-xxl) auto 0; }
        .lp-proof-tiles {
          list-style: none; margin: 0; padding: 0;
          display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
          gap: var(--space-sm);
        }
        .lp-proof-tile {
          display: flex; flex-direction: column; align-items: center; gap: 6px;
          padding: var(--space-lg) var(--space-md);
          background: color-mix(in srgb, var(--color-surface-1) 85%, transparent);
          border: 1px solid var(--color-hairline-soft);
          border-radius: var(--radius-lg);
          transition: border-color 0.15s ease;
        }
        .lp-proof-tile.is-open { border-color: color-mix(in srgb, var(--color-accent) 45%, transparent); }
        .lp-proof-value {
          font-size: 30px; font-weight: 650; letter-spacing: -1px; line-height: 1;
          color: var(--color-ink); font-variant-numeric: tabular-nums;
        }
        .lp-proof-label {
          display: inline-flex; align-items: center; gap: 6px;
          font-size: 13px; color: var(--color-ink-muted); text-align: center;
        }
        .lp-proof-help {
          flex-shrink: 0;
          width: 24px; height: 24px; border-radius: var(--radius-pill);
          display: inline-flex; align-items: center; justify-content: center;
          background: var(--color-surface-2); color: var(--color-ink-muted);
          border: 1px solid var(--color-hairline);
          font-size: 12px; font-weight: 600; line-height: 1; cursor: pointer;
          transition: color 0.15s ease, border-color 0.15s ease;
        }
        .lp-proof-help:hover, .lp-proof-help[aria-expanded="true"] { color: var(--color-accent); border-color: var(--color-accent); }
        .lp-proof-help:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
        .lp-proof-def {
          margin: var(--space-md) auto 0; max-width: 60ch;
          font-size: 13px; line-height: 1.5; color: var(--color-ink-muted);
        }
        .lp-proof-note { margin: var(--space-sm) 0 0; font-size: 12px; color: var(--color-ink-muted); }
        @media (max-width: 480px) {
          .lp-proof-tiles { grid-template-columns: 1fr 1fr; }
          .lp-proof-value { font-size: 24px; }
          .lp-proof-label { font-size: 12px; }
        }
        @media (prefers-reduced-motion: reduce) { .lp-proof-tile, .lp-proof-help { transition: none; } }
      `}</style>
    </div>
  );
}
