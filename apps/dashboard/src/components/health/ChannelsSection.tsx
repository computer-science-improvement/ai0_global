// Spec 091 FR-008: "Channels" on /app/health — one row per channel for today: state badge, published / target bar,
// replacements and recovery runs, the controller's reason, a 7-day strip. A click opens the seven days.

import { useState } from 'react';
import { SectionCard, EmptyState } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Modal } from '../Modal';
import { describeError } from '../ui/Toast';
import { fmtRelative } from '../../lib/format';
import { useSlo } from '../../api/slo';
import {
  MARK_LABEL, SLO_STATE_HINT, SLO_STATE_LABEL, SLO_STATE_TONE, belowTarget, channelViews, effortText, stripText, type ChannelView,
} from '../../lib/slo';
import './health.css';

function Strip({ v }: { v: ChannelView }) {
  return (
    <span className="slo-strip" role="img" aria-label={`Last 7 days: ${stripText(v.strip)}`}>
      {v.strip.map((c) => <span key={c.day} className={`slo-cell is-${c.mark}`} title={`${c.day}: ${MARK_LABEL[c.mark]}`} />)}
    </span>
  );
}

function ChannelRow({ v }: { v: ChannelView }) {
  const [open, setOpen] = useState(false);
  const r = v.row;
  const effort = effortText(r);
  return (
    <>
      <button type="button" className="panel-row slo-row" onClick={() => setOpen(true)} aria-haspopup="dialog" title="Open the last 7 days">
        <span className="slo-main">
          <span className="slo-title">
            <span className="mono">{r.channelKey}</span>
            <Badge tone={SLO_STATE_TONE[r.state]} title={SLO_STATE_HINT[r.state]}>{SLO_STATE_LABEL[r.state]}</Badge>
          </span>
          {r.reason && <span className="text-caption ink-muted clamp" style={{ ['--clamp' as string]: 2 }}>{r.reason}</span>}
        </span>
        <span className="slo-bar">
          <span className="mono text-caption">{r.published} / {r.target}</span>
          <span className="hl-meter" aria-hidden="true"><span className={`hl-meter-fill${r.published >= r.target ? ' is-ok' : ''}`} style={{ width: `${v.pct}%`, display: 'block' }} /></span>
          {effort && <span className="mono text-micro ink-dim">{effort}</span>}
        </span>
        <Strip v={v} />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} size="lg" icon="channels" title={r.channelKey} subtitle="Daily minimum, last 7 days">
        <div className="table-wrap">
          <table className="table">
            <thead><tr>
              <th>Day</th><th>State</th><th className="num">Published / target</th><th className="num">Replacements</th><th className="num">Recovery runs</th><th>Reason</th>
            </tr></thead>
            <tbody>
              {[...v.strip].reverse().map((c) => (
                <tr key={c.day}>
                  <td className="mono">{c.day}</td>
                  <td>{c.row ? <Badge tone={SLO_STATE_TONE[c.row.state]}>{SLO_STATE_LABEL[c.row.state]}</Badge> : <span className="ink-dim">No data</span>}</td>
                  <td className="num mono">{c.row ? `${c.row.published} / ${c.row.target}` : '—'}</td>
                  <td className="num mono">{c.row?.replacements ?? '—'}</td>
                  <td className="num mono">{c.row?.recoveryRuns ?? '—'}</td>
                  <td className="text-caption ink-muted">{c.row?.reason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-caption ink-dim" style={{ marginBottom: 0 }}>
          {r.lastPostAt ? `Last post ${fmtRelative(r.lastPostAt)}.` : 'No post recorded yet.'}
          {r.darkSince ? ` Dark since ${fmtRelative(r.darkSince)}.` : ''}
        </p>
        <div className="modal-foot"><button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Close</button></div>
      </Modal>
    </>
  );
}

export function ChannelsSection({ delay }: { delay?: number }) {
  const q = useSlo();
  const views = q.data ? channelViews(q.data) : null;
  const below = views ? belowTarget(views) : 0;
  return (
    <SectionCard
      title="Channels" icon="channels" flush delay={delay} style={{ marginBottom: 16 }}
      action={views?.length ? <span className={`hl-count${below ? ' is-warn' : ''}`}>{below ? `${below} below target` : 'all on target'}</span> : undefined}
    >
      {q.error ? <div className="hl-pad"><div className="callout-danger" role="alert">{describeError(q.error)}</div></div>
        : !views ? <div className="hl-skeleton" aria-busy="true" style={{ height: 120 }} />
        : !views.length ? <EmptyState tone="clear" title="No channel data yet" note="No channel data yet: the controller writes it every few minutes." />
        : views.map((v) => <ChannelRow key={v.row.channelKey} v={v} />)}
    </SectionCard>
  );
}
