// PUBLIC advertiser report (spec 008 T005). Outside the /app guard like the
// landing page; the token in the URL is the only key (served by
// GET /api/ads/report/:token, which returns only the report JSON).
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { SectionCard, StatStrip, StatTile } from '../components/ui/primitives';
import { PageHeader } from '../components/ui/PageHeader';
import { Badge } from '../components/ui/Badge';
import { Icon } from '../components/ui/Icon';
import { SkeletonRows } from '../components/SkeletonRows';
import { useAdReport } from '../api/ads';
import type { AdReport } from '../api/types';
import '../components/report/report.css';

export const Route = createFileRoute('/report/$token')({ component: ReportPage });

const n = (v: number | null) => (v == null ? '—' : v.toLocaleString('en-GB'));
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Width of a box in px (re-read on resize), so the chart can be drawn 1 unit = 1px and keep its labels legible. */
function useBoxWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => { const v = Math.round(el.getBoundingClientRect().width); if (v > 0) setW(v); };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Views over hours since publication — a plain SVG polyline in the accent color. */
function Curve({ points }: { points: AdReport['curve'] }) {
  const [boxRef, boxW] = useBoxWidth();
  const pts = points.filter((p) => p.views != null) as Array<{ hours: number; views: number }>;
  if (pts.length < 2) return <div ref={boxRef} className="rp-curve"><p className="rp-empty">Not enough measurements for a chart yet.</p></div>;
  // Room for axis labels: left for views, bottom for hours since publication.
  const W = Math.min(Math.max(boxW, 240), 760), H = 190, L = 44, R = 12, T = 12, B = 28;
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
    <div ref={boxRef} className="rp-curve">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Views by hours since publication">
        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line x1={L} y1={y(v)} x2={W - R} y2={y(v)} stroke="var(--color-hairline-soft)" strokeDasharray={v === 0 ? undefined : '3 4'} />
            <text x={L - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fill="var(--color-ink-dim)">{fmtV(v)}</text>
          </g>
        ))}
        {xTicks.map((h) => (
          <text key={`x${h}`} x={x(h)} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--color-ink-dim)">{h} h</text>
        ))}
        <polyline points={`${x(pts[0].hours)},${H - B} ${line} ${x(pts[pts.length - 1].hours)},${H - B}`}
          fill="color-mix(in srgb, var(--color-accent) 14%, transparent)" stroke="none" />
        <polyline points={line} fill="none" stroke="var(--color-accent)" strokeWidth={2} strokeLinejoin="round" />
        {pts.map((p) => (
          <circle key={`p${p.hours}`} cx={x(p.hours)} cy={y(p.views)} r={3} fill="var(--color-accent)">
            <title>{`${p.hours} h — ${p.views.toLocaleString('en-GB')} views`}</title>
          </circle>
        ))}
      </svg>
    </div>
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
          <span className="rp-head-tag">Advertiser report</span>
        </header>

        {q.isLoading && <SkeletonRows rows={1} height={220} label="Loading the report" />}

        {q.isError && (
          <div className="callout-warning rp-error" role="alert">
            <Icon name="warning" size={16} />
            <span>Report not found. Check the link or contact us.</span>
          </div>
        )}

        {r && (
          <>
            <div className="rp-hero">
              <PageHeader
                title={r.advertiser}
                subtitle={<>
                  {r.channel.url ? <a href={r.channel.url} target="_blank" rel="noreferrer">{r.channel.title ?? r.channel.key}</a> : (r.channel.title ?? r.channel.key)}
                  {' · '}published {when(r.post.publishedAt)}
                  {r.post.url && <> · <a href={r.post.url} target="_blank" rel="noreferrer">open the post</a></>}
                </>}
                actions={<Badge tone={r.stage === '72h' ? 'success' : 'accent'}>{r.stage === '72h' ? 'final · 72 h' : 'first day · 24 h'}</Badge>}
              />
            </div>

            <StatStrip label="Report metrics">
              <StatTile label="Views" value={n(r.metrics.views)} icon="eye" accent />
              <StatTile label="Forwards" value={n(r.metrics.forwards)} icon="refresh" />
              <StatTile label="Reactions" value={n(r.metrics.reactions)} icon="sparkles" />
              <StatTile
                label="Reach"
                value={r.reachRate == null ? '—' : `${Math.round(r.reachRate * 100)}%`}
                delta={r.channel.subscribers ? `of ${n(r.channel.subscribers)} subscribers` : undefined}
                icon="channels"
              />
            </StatStrip>

            <SectionCard title="Views by hours since publication" delay={60}>
              <Curve points={r.curve} />
            </SectionCard>

            {r.link && (
              <SectionCard title="Link in the post" delay={120}>
                <div className="rp-card-body">
                  <span className="text-body-sm mono rp-url">{r.link.url}</span>
                  <span className="rp-note">
                    {r.link.utm
                      ? 'The link has UTM tags — clicks show up in your analytics (utm_source / utm_campaign).'
                      : 'Telegram does not report link clicks; add UTM tags to the link to see them in your analytics.'}
                  </span>
                </div>
              </SectionCard>
            )}

            <p className="rp-foot">
              Data as of {when(r.metrics.capturedAt ?? r.generatedAt)}.
              {r.stage === '24h' && ' The final report appears at this same link 72 hours after publication.'}
            </p>
          </>
        )}
      </main>
    </div>
  );
}
