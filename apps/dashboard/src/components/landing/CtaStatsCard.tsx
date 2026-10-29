// Spec 026 FR-015: CTA stats on /app/landing. Clicks per placement over 30 days (the
// anonymous beacon counters), set against DM threads the triage attributed to that
// placement (the ai0web tag) and form leads. Untagged ad DMs are shown too: they are
// people who removed the tag or whose Telegram client dropped the prefilled text.
// Spec 078 (C6): the totals are a StatStrip above the per-placement table (the old Total row).
import type { JSX } from 'react';
import { SectionCard, EmptyState, StatStrip, StatTile } from '../ui/primitives';
import { SkeletonRows } from '../SkeletonRows';
import { useLandingCtaStats } from '../../api/landing';
import { describeError } from '../ui/Toast';
import './landing-admin.css';

const PLACEMENT_LABEL: Record<string, string> = {
  hero: 'Hero', topbar: 'Top bar', network: 'Network block', resource: 'Channel card',
  mediakit: 'Media kit', advertise: 'Advertise block', footer: 'Footer', howitworks: 'How it works',
  whitelabel: 'White-label section/page', unknown: 'Unknown',
};

const rate = (num: number, den: number) => (den > 0 ? `${Math.round((num / den) * 100)}%` : '—');

export function CtaStatsCard(): JSX.Element {
  const { data, isLoading, error } = useLandingCtaStats(30);
  const empty = data && data.rows.length === 0 && data.untaggedAdThreads === 0;

  return (
    <SectionCard title="CTA stats · last 30 days" delay={0}>
      <p className="cs-intro">
        Clicks on the landing’s ad buttons, and how many people then actually wrote: DM threads that still carry the
        landing tag, and requests sent through the form. Clicks are anonymous day counters; no visitor data is kept.
      </p>
      {isLoading && <SkeletonRows rows={3} height={48} label="Loading CTA stats" />}
      {error && (
        <div className="callout-danger" role="alert">
          Couldn’t load CTA stats: {describeError(error)}
        </div>
      )}
      {empty && (
        <EmptyState icon="analytics" title="No clicks yet" note="Counts appear after the first click on a landing ad button." />
      )}
      {data && !empty && (
        <>
          <div className="cs-strip">
            <StatStrip label="Totals for the last 30 days">
              <StatTile label="Telegram clicks" value={data.totals.dmClicks} />
              <StatTile label="Tagged DM threads" value={data.totals.dmThreads} />
              <StatTile label="DM rate" value={rate(data.totals.dmThreads, data.totals.dmClicks)} />
              <StatTile label="Form opens" value={data.totals.formClicks} />
              <StatTile label="Form leads" value={data.totals.leads} />
              <StatTile label="White-label clicks" value={data.totals.whiteLabelClicks} />
            </StatStrip>
          </div>
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
              </tbody>
            </table>
          </div>
          <p className="cs-foot">
            Since {data.since} (UTC). Ad DM threads without a landing tag in the same period: {data.untaggedAdThreads}.
          </p>
        </>
      )}
    </SectionCard>
  );
}
