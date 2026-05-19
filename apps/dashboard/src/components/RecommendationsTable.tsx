import type { RecommendationItem } from '../api/types';

interface Props {
  items:        RecommendationItem[];
  targetThemes: string[];
}

export function RecommendationsTable({ items, targetThemes }: Props) {
  if (items.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-6 text-center text-sm text-gray-500">
        No matches for this target / budget.
      </p>
    );
  }

  const targetSet = new Set(targetThemes);

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
          <tr>
            <th className="px-3 py-2">#</th>
            <th className="px-3 py-2">Channel</th>
            <th className="px-3 py-2">Themes</th>
            <th className="px-3 py-2 text-right">Score</th>
            <th className="px-3 py-2 text-right">Price (UAH)</th>
            <th className="px-3 py-2 text-right">Subs/ad</th>
            <th className="px-3 py-2 text-right">F/M</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {items.map((r, idx) => (
            <tr key={r.id} className="border-t hover:bg-gray-50">
              <td className="px-3 py-2 font-mono text-xs text-gray-500">{idx + 1}</td>
              <td className="px-3 py-2">
                <div className="flex items-center gap-2">
                  {r.avatarUrl && (
                    <img src={r.avatarUrl} alt="" className="h-7 w-7 rounded-full object-cover" />
                  )}
                  <div>
                    <div className="font-medium">{r.title}</div>
                    <a
                      href={r.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-xs text-blue-600 hover:underline"
                    >
                      @{r.slug}
                    </a>
                  </div>
                </div>
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-1">
                  {r.themes.slice(0, 5).map(t => (
                    <span
                      key={t}
                      className={`rounded px-2 py-0.5 text-xs ${
                        targetSet.has(t)
                          ? 'bg-blue-100 font-semibold text-blue-900'
                          : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {t}
                    </span>
                  ))}
                  {r.themes.length > 5 && (
                    <span className="text-xs text-gray-400">+{r.themes.length - 5}</span>
                  )}
                </div>
              </td>
              <td className="px-3 py-2 text-right font-mono">{(r.score * 100).toFixed(0)}%</td>
              <td className="px-3 py-2 text-right font-mono">{(r.priceMin / 100).toFixed(0)}</td>
              <td className="px-3 py-2 text-right font-mono">
                {r.estimatedSubsPerAd == null
                  ? '—'
                  : (r.estimatedSubsPerAd > 0 ? '+' : '') + r.estimatedSubsPerAd}
              </td>
              <td className="px-3 py-2 text-right font-mono">
                {r.sexRatio == null ? '—' : `${r.sexRatio}/${100 - r.sexRatio}`}
              </td>
              <td className="px-3 py-2 text-right">
                <a
                  href={r.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-blue-600 hover:underline"
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
