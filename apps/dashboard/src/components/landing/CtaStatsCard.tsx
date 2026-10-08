// Spec 026 FR-015: CTA stats on /app/landing. Clicks per placement over 30 days (the
// anonymous beacon counters), set against DM threads the triage attributed to that
// placement (the ai0web tag) and form leads. Untagged ad DMs are shown too: they are
// people who removed the tag or whose Telegram client dropped the prefilled text.
import type { JSX } from 'react';
import { SectionCard, EmptyState } from '../ui/primitives';
import { useLandingCtaStats } from '../../api/landing';

const PLACEMENT_LABEL: Record<string, string> = {
  hero: 'Hero', topbar: 'Top bar', network: 'Network block', resource: 'Channel card',
  mediakit: 'Media kit', advertise: 'Advertise block', footer: 'Footer', howitworks: 'How it works',
  white_label: 'White-label page', unknown: 'Unknown',
};

const rate = (num: number, den: number) => (den > 0 ? `${Math.round((num / den) * 100)}%` : '—');

export function CtaStatsCard(): JSX.Element {
  const { data, isLoading, error } = useLandingCtaStats(30);
  const empty = data && data.rows.length === 0 && data.untaggedAdThreads === 0;

  return (
    <SectionCard title="CTA stats · last 30 days" icon="analytics">
      <p className="text-body-sm" style={{ margin: '0 0 12px', color: 'var(--color-ink-muted)' }}>
        Clicks on the landing’s ad buttons, and how many people then actually wrote: DM threads that still carry the
        landing tag, and requests sent through the form. Clicks are anonymous day counters; no visitor data is kept.
      </p>
      {isLoading && <div className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>Loading…</div>}
      {error && (
        <div className="text-body-sm" role="alert" style={{ color: 'var(--color-danger)' }}>
          Couldn’t load CTA stats: {(error as Error).message}
        </div>
      )}
      {empty && (
        <EmptyState icon="analytics" title="No clicks yet" note="Counts appear after the first click on a landing ad button." />
      )}
      {data && !empty && (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Placement</th>
                  <th className="num">Telegram clicks</th>
                  <th className="num">Tagged DM threads</th>
                  <th className="num">DM rate</th>
                  <th className="num">Form opens</th>
                  <th className="num">Form leads</th>
                  <th className="num">White-label clicks</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.placement}>
                    <td>{PLACEMENT_LABEL[r.placement] ?? r.placement}</td>
                    <td className="num">{r.dmClicks}</td>
                    <td className="num">{r.dmThreads}</td>
                    <td className="num">{rate(r.dmThreads, r.dmClicks)}</td>
                    <td className="num">{r.formClicks}</td>
                    <td className="num">{r.leads}</td>
                    <td className="num">{r.whiteLabelClicks}</td>
                  </tr>
                ))}
                <tr>
                  <td style={{ fontWeight: 600 }}>Total</td>
                  <td className="num" style={{ fontWeight: 600 }}>{data.totals.dmClicks}</td>
                  <td className="num" style={{ fontWeight: 600 }}>{data.totals.dmThreads}</td>
                  <td className="num" style={{ fontWeight: 600 }}>{rate(data.totals.dmThreads, data.totals.dmClicks)}</td>
                  <td className="num" style={{ fontWeight: 600 }}>{data.totals.formClicks}</td>
                  <td className="num" style={{ fontWeight: 600 }}>{data.totals.leads}</td>
                  <td className="num" style={{ fontWeight: 600 }}>{data.totals.whiteLabelClicks}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-micro" style={{ margin: '10px 0 0', color: 'var(--color-ink-dim)' }}>
            Since {data.since} (UTC). Ad DM threads without a landing tag in the same period: {data.untaggedAdThreads}.
          </p>
        </>
      )}
    </SectionCard>
  );
}
