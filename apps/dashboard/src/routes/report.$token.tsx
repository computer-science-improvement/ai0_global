// PUBLIC advertiser report (spec 008 T005). Outside the /app guard like the
// landing page; the token in the URL is the only key (served by
// GET /api/ads/report/:token, which returns only the report JSON).
import { createFileRoute } from '@tanstack/react-router';
import { StatTile } from '../components/ui/primitives';
import { Badge } from '../components/ui/Badge';
import { Icon } from '../components/ui/Icon';
import { useAdReport } from '../api/ads';
import type { AdReport } from '../api/types';

export const Route = createFileRoute('/report/$token')({ component: ReportPage });

const n = (v: number | null) => (v == null ? '—' : v.toLocaleString('uk-UA'));

/** Views over hours since publication — a plain SVG polyline in the accent color. */
function Curve({ points }: { points: AdReport['curve'] }) {
  const pts = points.filter((p) => p.views != null) as Array<{ hours: number; views: number }>;
  if (pts.length < 2) return <p className="text-body-sm" style={{ color: 'var(--color-ink-dim)', margin: 0 }}>Замало замірів для графіка.</p>;
  // Room for axis labels: left for views, bottom for hours since publication.
  const W = 640, H = 190, L = 44, R = 12, T = 12, B = 28;
  const maxH = Math.max(...pts.map((p) => p.hours));
  const maxV = Math.max(...pts.map((p) => p.views), 1);
  const x = (h: number) => L + (h / maxH) * (W - L - R);
  const y = (v: number) => H - B - (v / maxV) * (H - B - T);
  const line = pts.map((p) => `${x(p.hours).toFixed(1)},${y(p.views).toFixed(1)}`).join(' ');
  const fmtV = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k` : String(v));
  const yTicks = [0, Math.round(maxV / 2), maxV];
  // Thin out crowded early ticks (1 h, 2 h, 3 h…) so labels never overlap; always keep the last one.
  const xTicks: number[] = [];
  for (const p of pts) {
    const prev = xTicks[xTicks.length - 1];
    if (prev === undefined || x(p.hours) - x(prev) >= 56) xTicks.push(p.hours);
  }
  const last = pts[pts.length - 1].hours;
  if (xTicks[xTicks.length - 1] !== last) { if (x(last) - x(xTicks[xTicks.length - 1]) < 56) xTicks.pop(); xTicks.push(last); }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Перегляди за годинами після публікації" style={{ width: '100%', height: 'auto', display: 'block' }}>
      {yTicks.map((v) => (
        <g key={`y${v}`}>
          <line x1={L} y1={y(v)} x2={W - R} y2={y(v)} stroke="var(--color-hairline-soft)" strokeDasharray={v === 0 ? undefined : '3 4'} />
          <text x={L - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fill="var(--color-ink-dim)">{fmtV(v)}</text>
        </g>
      ))}
      {xTicks.map((h) => (
        <text key={`x${h}`} x={x(h)} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--color-ink-dim)">{h} год</text>
      ))}
      <polyline points={`${x(pts[0].hours)},${H - B} ${line} ${x(pts[pts.length - 1].hours)},${H - B}`}
        fill="color-mix(in srgb, var(--color-accent) 14%, transparent)" stroke="none" />
      <polyline points={line} fill="none" stroke="var(--color-accent)" strokeWidth={2} strokeLinejoin="round" />
      {pts.map((p) => (
        <circle key={`p${p.hours}`} cx={x(p.hours)} cy={y(p.views)} r={3} fill="var(--color-accent)">
          <title>{`${p.hours} год — ${p.views.toLocaleString('uk-UA')} переглядів`}</title>
        </circle>
      ))}
    </svg>
  );
}

function ReportPage() {
  const { token } = Route.useParams();
  const q = useAdReport(token);
  const r = q.data;

  return (
    <div className="rp-root">
      <main className="rp-main">
        <header className="rp-head">
          <span className="wordmark"><span className="dot" />ai0</span>
          <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>Звіт для рекламодавця</span>
        </header>

        {q.isLoading && <div className="card" style={{ height: 220, opacity: 0.5 }} />}

        {q.isError && (
          <div className="callout-warning">
            <Icon name="warning" size={16} />
            <span>Звіт не знайдено. Перевірте посилання або напишіть нам.</span>
          </div>
        )}

        {r && (
          <>
            <section className="rp-hero">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <h1 className="text-display-md" style={{ margin: 0 }}>{r.advertiser}</h1>
                <Badge tone={r.stage === '72h' ? 'success' : 'accent'}>{r.stage === '72h' ? 'фінальний · 72 год' : 'перша доба · 24 год'}</Badge>
              </div>
              <p className="text-body" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>
                {r.channel.url ? <a href={r.channel.url} target="_blank" rel="noreferrer">{r.channel.title ?? r.channel.key}</a> : (r.channel.title ?? r.channel.key)}
                {' · '}опубліковано {new Date(r.post.publishedAt).toLocaleString('uk-UA')}
                {r.post.url && <> · <a href={r.post.url} target="_blank" rel="noreferrer">відкрити пост</a></>}
              </p>
            </section>

            <section className="rp-tiles">
              <StatTile label="Перегляди" value={n(r.metrics.views)} icon="eye" accent />
              <StatTile label="Пересилання" value={n(r.metrics.forwards)} icon="refresh" />
              <StatTile label="Реакції" value={n(r.metrics.reactions)} icon="sparkles" />
              <StatTile
                label="Охоплення"
                value={r.reachRate == null ? '—' : `${Math.round(r.reachRate * 100)}%`}
                delta={r.channel.subscribers ? `від ${n(r.channel.subscribers)} підписників` : undefined}
                icon="channels"
              />
            </section>

            <section className="card rp-card">
              <span className="text-eyebrow">Перегляди за годинами після публікації</span>
              <Curve points={r.curve} />
            </section>

            {r.link && (
              <section className="card rp-card">
                <span className="text-eyebrow">Посилання в пості</span>
                <span className="text-body-sm" style={{ wordBreak: 'break-all' }}>{r.link.url}</span>
                <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>
                  {r.link.utm
                    ? 'Посилання має UTM-мітки — переходи видно у вашій аналітиці (utm_source / utm_campaign).'
                    : 'Telegram не показує кількість переходів; додайте UTM-мітки до посилання, щоб бачити їх у своїй аналітиці.'}
                </span>
              </section>
            )}

            <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: 0 }}>
              Дані станом на {new Date(r.metrics.capturedAt ?? r.generatedAt).toLocaleString('uk-UA')}.
              {r.stage === '24h' && ' Фінальний звіт зʼявиться за цим же посиланням через 72 години після публікації.'}
            </p>
          </>
        )}
      </main>

      <style>{`
        .rp-root { min-height: 100vh; background: var(--color-canvas); color: var(--color-ink); }
        .rp-main {
          max-width: 760px; margin: 0 auto;
          padding: var(--space-xl) var(--space-xl) var(--space-section);
          display: flex; flex-direction: column; gap: var(--space-xl);
        }
        .rp-head { display: flex; align-items: center; justify-content: space-between; }
        .rp-head .wordmark { font-size: 16px; }
        .rp-hero { display: flex; flex-direction: column; gap: var(--space-sm); }
        .rp-hero a, .rp-card a { color: var(--color-accent); }
        .rp-tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--space-md); }
        @media (max-width: 720px) { .rp-tiles { grid-template-columns: repeat(2, 1fr); } }
        .rp-card { display: flex; flex-direction: column; gap: var(--space-sm); padding: var(--space-lg); }
        @media (max-width: 600px) { .rp-main { padding-left: var(--space-lg); padding-right: var(--space-lg); } }
      `}</style>
    </div>
  );
}
