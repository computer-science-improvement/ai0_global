// Spec 078 B1: "Today's schedule": one lane per channel on a fixed 06:00-24:00 axis in Kyiv time. Every Telegram slot of the
// channel's active plan is a StatusMark (the shape tells the status; green alone would not), the now-line moves once a minute
// and what is already past is shaded. A marker opens the slot. The layout maths (rows, positions, the now-line) is lib/today.ts.

import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { SectionCard, EmptyState } from '../ui/primitives';
import { Button } from '../ui/Button';
import { StatusMark } from '../ui/StatusMark';
import { AgentGlyph } from '../agents/AgentsUi';
import { useAgentTree } from '../../api/agents';
import { MARK_LABEL } from '../../lib/status-tone';
import { AXIS_HOURS, axisPct, laneHeight, legendMarks, nowLine, orchestratorsByChannel, pastPct, type Lane } from '../../lib/today';
import type { TodayDay } from './useTodayDay';
import './today.css';

const hourLabel = (h: number) => String(h).padStart(2, '0');

function LaneLabel({ channelKey, name, emoji, handle, to }: {
  channelKey: string; name: string; emoji: string | null; handle: string | null;
  to: { kind: 'agent'; handle: string } | { kind: 'channel' };
}) {
  return (
    <div className="tl-label">
      <AgentGlyph agent={{ emoji, kind: 'orchestrator' }} size={28} />
      <div className="tl-label-text">
        {to.kind === 'agent'
          ? <Link to="/app/agents/$handle" params={{ handle: to.handle }} className="tl-name" title={name}>{name}</Link>
          : <Link to="/app/editor/$channel" params={{ channel: channelKey }} className="tl-name" title={name}>{name}</Link>}
        <span className="mono tl-handle" title={handle ?? channelKey}>{handle ? `@${handle}` : channelKey}</span>
      </div>
    </div>
  );
}

function LaneTrack({ lane }: { lane: Lane }) {
  return (
    <div className={`tl-track${lane.rows > 1 ? ' is-stacked' : ''}`} style={{ height: laneHeight(lane.rows) }}>
      <div className="tl-plane">
        {lane.markers.length === 0 && <span className="tl-empty">No plan for today yet</span>}
        {lane.markers.map((m) => (
          <Link
            key={m.id}
            to="/app/editor/slot/$id"
            params={{ id: m.id }}
            className={`tl-mark${m.clamped ? ' is-clamped' : ''}`}
            style={{ left: `${m.pct}%`, top: 14 + m.row * 20 }}
            aria-label={m.label}
            title={m.label}
          >
            <StatusMark status={m.mark} decorative size={16} />
          </Link>
        ))}
      </div>
    </div>
  );
}

export function DayTimeline({ day, now, delay }: { day: TodayDay; now: Date; delay?: number }) {
  const tree = useAgentTree();
  const orchestrators = useMemo(() => orchestratorsByChannel(tree.data?.agents), [tree.data]);
  const titles = useMemo(() => new Map((day.channels ?? []).map((c) => [c.channelKey, c.title])), [day.channels]);

  const total = day.lanes.reduce((n, l) => n + l.markers.length, 0);
  const marks = useMemo(() => legendMarks(day.lanes), [day.lanes]);
  const line = day.day ? nowLine(now, day.day) : null;
  const past = day.day ? pastPct(now, day.day) : 0;

  const action = <Link to="/app/calendar" className="panel-link">Open calendar →</Link>;

  if (day.failed) {
    return (
      <SectionCard title="Today's schedule" flush delay={delay}>
        <EmptyState icon="warning" title="Today's plan could not be loaded" note="The server did not answer. The rest of the page still works."
          action={<Button type="button" variant="secondary" size="sm" onClick={() => { void day.plansQ.refetch(); }}>Try again</Button>} />
      </SectionCard>
    );
  }
  if (day.loading) {
    return (
      <SectionCard title="Today's schedule" flush delay={delay} action={action}>
        <p className="text-caption ink-muted" role="status" style={{ margin: 0, padding: '28px 20px', textAlign: 'center' }}>Loading today's schedule…</p>
      </SectionCard>
    );
  }
  if (day.editorOff) {
    return (
      <SectionCard title="Today's schedule" flush delay={delay}>
        <EmptyState icon="calendar" title="The editor is switched off" note="Nothing is planned or posted by the agents until it is switched on on the server." />
      </SectionCard>
    );
  }
  if (total === 0) {
    return (
      <SectionCard title="Today's schedule" flush delay={delay} action={action}>
        <EmptyState icon="calendar" title="Nothing planned for today"
          note="An agent writes its plan for the day in the morning; a channel in approval is planned the evening before." />
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Today's schedule" flush delay={delay} action={action}>
      <div className="tl-scroll" role="region" aria-label="Today's schedule, scrolls sideways on a narrow screen" tabIndex={0}>
        <div className="tl">
          <div className="tl-axis">
            <span className="text-overline tl-zone">Kyiv time</span>
            <div className="tl-track tl-ticks">
              <div className="tl-plane">
                {AXIS_HOURS.map((h) => (
                  <span key={h} className="mono tl-tick" style={{ left: `${axisPct(h * 60)}%` }}>{hourLabel(h)}</span>
                ))}
              </div>
            </div>
          </div>

          {day.lanes.map((lane) => {
            const agent = orchestrators.get(lane.channelKey);
            return (
              <div className="tl-lane" key={lane.channelKey}>
                <LaneLabel
                  channelKey={lane.channelKey}
                  name={agent?.name || titles.get(lane.channelKey) || lane.channelKey}
                  emoji={agent?.emoji ?? null}
                  handle={agent?.handle ?? null}
                  to={agent ? { kind: 'agent', handle: agent.handle } : { kind: 'channel' }}
                />
                <LaneTrack lane={lane} />
              </div>
            );
          })}

          {/* Past shading and the now-line sit over the tracks, not over the labels. */}
          <div className="tl-overlay" aria-hidden="true">
            <div className="tl-plane">
              {past > 0 && <div className="tl-past" style={{ width: `${past}%` }} />}
              {line && (
                <div className="tl-now" style={{ left: `${line.pct}%` }}>
                  <span className="mono tl-now-label">{line.label}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="panel-foot tl-legend">
        {marks.map((k) => (
          <span key={k} className="tl-legend-item text-micro"><StatusMark status={k} decorative size={12} />{MARK_LABEL[k]}</span>
        ))}
        <span className="text-micro tl-legend-hint">Select a mark to open the post.</span>
      </div>
    </SectionCard>
  );
}
