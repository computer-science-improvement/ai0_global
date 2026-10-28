// Spec 078 B4: /app/calendar. A 5-day window (`?from=`) with one row per orchestrator and an "Other channels" row. A cell holds
// the agent's slots (the status system's marks), the series and pins the planner has not written yet ("not planned"), and
// the owner's own scheduled posts. This component owns the queries and the toolbar; lib/calendar.ts builds the rows.

import './calendar.css';
import { Link } from '@tanstack/react-router';
import { PageHeader } from '../ui/PageHeader';
import { Icon } from '../ui/Icon';
import { EmptyState } from '../ui/primitives';
import { useAgentTree } from '../../api/agents';
import { useCalendarChannels, useCalendarPauses, useCalendarPosts, useCalendarSchedules } from '../../api/calendar';
import { useMediaQuery } from '../../lib/useMediaQuery';
import {
  WINDOW_DAYS, addDays, buildRows, calendarAgents, dayLabel, kyivToday, rangeLabel, resolveFrom, windowDays,
  type CalRow, type CalendarSearch,
} from '../../lib/calendar';
import { CalLegend, DayAgenda, WeekGrid } from './WeekGrid';
import { ComposerDrawer } from './ComposerDrawer';
import { useMinute } from './useMinute';

type Patch = { [K in keyof CalendarSearch]?: CalendarSearch[K] | undefined };

export function CalendarPage({ search, setSearch }: { search: CalendarSearch; setSearch: (patch: Patch, opts?: { replace?: boolean }) => void }) {
  const now = useMinute();
  const today = kyivToday(now);
  const from = resolveFrom(search.from, today);
  const days = windowDays(from);
  const phone = useMediaQuery('(max-width: 760px)');

  const tree = useAgentTree();
  const agents = calendarAgents(tree.data?.agents);
  const handles = agents.map((a) => a.handle);
  const schedules = useCalendarSchedules(handles, from);
  const pauses = useCalendarPauses(handles);
  const postsQ = useCalendarPosts();
  const channelsQ = useCalendarChannels();

  const rows = buildRows({
    agents, schedules, pauses, channels: channelsQ.data?.items ?? [], posts: postsQ.data ?? [], days, today,
  });
  const loading = tree.isLoading || channelsQ.isLoading;

  // A `from` equal to today is the default and stays out of the address.
  const go = (to: string) => setSearch({ from: to === today ? undefined : to });
  // The composer is a drawer driven by the address: Back closes it, and a copied link reopens it.
  const onAdd = (row: CalRow, day: string) => setSearch({ compose: 'new', channel: row.composeKey ?? undefined, day, post: undefined });
  const onOpenPost = (id: string) => setSearch({ compose: 'edit', post: id, channel: undefined, day: undefined });
  const closeDrawer = () => setSearch({ compose: undefined, channel: undefined, day: undefined, post: undefined }, { replace: true });

  return (
    <div>
      <PageHeader
        eyebrow={`Today ${dayLabel(today)} · Kyiv`}
        title="Calendar"
        subtitle="Agent slots and your own posts on one timeline. Use Add to schedule a post."
        actions={(
          <div className="cal-nav">
            <button type="button" className="btn-act" aria-label={`Previous ${WINDOW_DAYS} days`} title={`Previous ${WINDOW_DAYS} days`} onClick={() => go(addDays(from, -WINDOW_DAYS))}>
              <Icon name="chevron-left" size={16} />
            </button>
            <button type="button" className="btn-secondary btn-sm" disabled={from === today} onClick={() => go(today)}>Today</button>
            <button type="button" className="btn-act" aria-label={`Next ${WINDOW_DAYS} days`} title={`Next ${WINDOW_DAYS} days`} onClick={() => go(addDays(from, WINDOW_DAYS))}>
              <Icon name="chevron-right" size={16} />
            </button>
            <span className="mono" aria-live="polite">{rangeLabel(days)}</span>
          </div>
        )}
      />

      {tree.error && !tree.data && (
        <div className="callout-danger cal-banner" role="alert">Agents did not load, so only channels without an agent and your own posts are shown below.</div>
      )}
      {postsQ.error && (
        <div className="callout-warning cal-banner" role="alert">Your scheduled posts did not load. Agent slots are shown without them.</div>
      )}

      {loading ? (
        <div className="panel is-section cal-panel" role="status" aria-busy>
          <p className="cal-cell-msg" style={{ padding: 20, margin: 0 }}>Loading the calendar…</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="panel is-section cal-panel">
          <EmptyState
            icon="calendar" title="Nothing to plan yet"
            note="Add a channel and its agent, and their posts show up here."
            action={<Link to="/app/channels" search={{ filter: 'mine', page: 1, q: '' }} className="btn-secondary btn-sm">Open channels</Link>}
          />
        </div>
      ) : (
        <>
          <CalLegend />
          {phone
            ? <DayAgenda rows={rows} days={days} today={today} onAdd={onAdd} onOpenPost={onOpenPost} />
            : (
              <section className="panel is-section is-flush cal-panel" aria-label="Week calendar">
                <WeekGrid rows={rows} days={days} today={today} onAdd={onAdd} onOpenPost={onOpenPost} />
              </section>
            )}
        </>
      )}

      <ComposerDrawer
        search={search} close={closeDrawer} today={today} agents={agents} schedules={schedules}
        channels={channelsQ.data?.items} channelsLoading={channelsQ.isLoading} posts={postsQ.data} postsLoading={postsQ.isLoading}
      />
    </div>
  );
}
