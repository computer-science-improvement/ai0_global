// Dark-canvas rewrite. Uses .table recipe (surface-1 wrapper, hairline-soft
// dividers, surface-2 row hover). Chips use .chip / .chip.is-active instead
// of the previous bg-blue-100/text-blue-900 light-theme pair. External
// links use .link-accent (single chromatic accent), not text-blue-600.
// font-mono dropped — global tabular-nums already aligns numeric cells.

import type { RecommendationItem } from '../api/types';

interface Props {
  items:        RecommendationItem[];
  targetThemes: string[];
}

export function RecommendationsTable({ items, targetThemes }: Props) {
  if (items.length === 0) {
    return (
      <div className="card" style={{
        textAlign: 'center', padding: 32,
        background: 'var(--color-surface-1)',
        border: '1px dashed var(--color-hairline)',
      }}>
        <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>
          No matches for this target / budget.
        </p>
      </div>
    );
  }

  const targetSet = new Set(targetThemes);

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 40 }}>#</th>
            <th>Channel</th>
            <th>Themes</th>
            <th className="num">Score</th>
            <th className="num">Price (UAH)</th>
            <th className="num">Subs/ad</th>
            <th className="num">F/M</th>
            <th style={{ width: 60 }}></th>
          </tr>
        </thead>
        <tbody>
          {items.map((r, idx) => (
            <tr key={r.id}>
              <td className="meta num" style={{ textAlign: 'left', width: 40 }}>{idx + 1}</td>
              <td>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {r.avatarUrl
                    ? <img src={r.avatarUrl} alt="" style={{ width: 32, height: 32, borderRadius: 9999, objectFit: 'cover' }} />
                    : <div style={{ width: 32, height: 32, borderRadius: 9999, background: 'var(--color-surface-2)' }} />}
                  <div style={{ minWidth: 0 }}>
                    <div className="text-body-sm" style={{ color: 'var(--color-ink)' }}>{r.title}</div>
                    <a
                      href={r.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="link-accent text-micro"
                    >
                      @{r.slug}
                    </a>
                  </div>
                </div>
              </td>
              <td>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {r.themes.slice(0, 5).map(t => (
                    <span key={t} className={targetSet.has(t) ? 'chip is-active' : 'chip'}>
                      {t}
                    </span>
                  ))}
                  {r.themes.length > 5 && (
                    <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>
                      +{r.themes.length - 5}
                    </span>
                  )}
                </div>
              </td>
              <td className="num">{(r.score * 100).toFixed(0)}%</td>
              <td className="num">{(r.priceMin / 100).toFixed(0)}</td>
              <td className="num">
                {r.estimatedSubsPerAd == null
                  ? <span style={{ color: 'var(--color-ink-dim)' }}>—</span>
                  : (r.estimatedSubsPerAd > 0 ? '+' : '') + r.estimatedSubsPerAd}
              </td>
              <td className="num">
                {r.sexRatio == null
                  ? <span style={{ color: 'var(--color-ink-dim)' }}>—</span>
                  : `${r.sexRatio}/${100 - r.sexRatio}`}
              </td>
              <td className="num">
                <a
                  href={r.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="link-accent text-body-sm"
                >
                  Open ↗
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
