// Spec 078 B1: the ring of "Today at a glance": how many of today's Telegram slots are done. Published and shadowed fill the
// ring in the accent colour, a failed slot is red, a missed one amber, a skipped one grey; what is still ahead stays track.
// The numbers beside it (the legend) say the same in words, so the ring itself is a picture with one accessible name.

import { ringArcs, type DaySummary } from '../../lib/today';
import { StatusMark } from '../ui/StatusMark';
import type { MarkKind } from '../../lib/status-tone';
import './today.css';

const R = 42;
const CIRCUMFERENCE = 2 * Math.PI * R;

const ARC_COLOR: Record<string, string> = {
  done:    'var(--color-accent)',
  failed:  'var(--color-danger)',
  missed:  'var(--color-warning)',
  skipped: 'var(--color-ink-dim)',
};

export function SlotRing({ summary }: { summary: DaySummary }) {
  const { total, done, counts } = summary;
  const arcs = ringArcs(
    [
      { key: 'done', value: done },
      { key: 'failed', value: counts.failed },
      { key: 'missed', value: counts.missed },
      { key: 'skipped', value: counts.skipped },
    ],
    total,
    CIRCUMFERENCE,
  );
  const label = total === 0 ? 'No slots planned today' : `${done} of ${total} slots done today`;
  return (
    <div className="slotring" role="img" aria-label={label}>
      <svg viewBox="0 0 100 100" width="104" height="104" aria-hidden="true" focusable="false">
        <circle cx="50" cy="50" r={R} fill="none" stroke="var(--color-surface-3)" strokeWidth="10" />
        <g transform="rotate(-90 50 50)">
          {arcs.map((a) => (
            <circle
              key={a.key} className="slotring-arc" cx="50" cy="50" r={R} fill="none" stroke={ARC_COLOR[a.key]} strokeWidth="10"
              strokeDasharray={`${a.dash} ${a.gap}`} strokeDashoffset={-a.offset}
            />
          ))}
        </g>
      </svg>
      <div className="slotring-centre">
        <span className="slotring-num tabular-nums">{done}<span className="slotring-of">/{total}</span></span>
        <span className="slotring-cap">{total === 0 ? 'no slots' : 'slots done'}</span>
      </div>
    </div>
  );
}

interface LegendRow { key: string; mark: MarkKind; label: string; value: number; always: boolean }

/** The ring's numbers in words: Published, Skipped and Missed always; the rest only when there is one. */
export function RingLegend({ summary }: { summary: DaySummary }) {
  const c = summary.counts;
  const rows: LegendRow[] = [
    { key: 'published', mark: 'published', label: 'Published', value: c.published, always: true },
    { key: 'shadowed',  mark: 'shadowed',  label: 'Shadowed',  value: c.shadowed,  always: false },
    { key: 'failed',    mark: 'failed',    label: 'Failed',    value: c.failed,    always: false },
    { key: 'missed',    mark: 'missed',    label: 'Missed',    value: c.missed,    always: true },
    { key: 'skipped',   mark: 'skipped',   label: 'Skipped',   value: c.skipped,   always: true },
    { key: 'ahead',     mark: 'planned',   label: 'Still to come', value: c.ahead, always: false },
  ];
  return (
    <ul className="slotring-legend">
      {rows.filter((r) => r.always || r.value > 0).map((r) => (
        <li key={r.key}>
          <StatusMark status={r.mark} decorative size={12} />
          <span>{r.label}</span>
          <span className="mono tabular-nums slotring-legend-n">{r.value}</span>
        </li>
      ))}
    </ul>
  );
}
