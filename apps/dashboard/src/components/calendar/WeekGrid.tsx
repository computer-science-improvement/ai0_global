// Spec 078 B4: the parts of the Calendar page that draw the 5-day grid (rows = orchestrators + "Other channels") and, on a
// phone, the same data as one panel per day. They import no CSS (calendar.css is imported by CalendarPage), so the node
// render test can mount them. All data comes in through props; the page owns the queries.

import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { HubGlyph, SectionCard } from '../ui/primitives';
import { StatusMark } from '../ui/StatusMark';
import { MODE_LABEL, MODE_TONE } from '../editor/EditorUi';
import type { MarkKind } from '../../lib/status-tone';
import { CELL_CHIPS, addLabel, dayLabel, dayParts, visibleChips, type CalChip, type CalRow } from '../../lib/calendar';

export interface GridHandlers {
  /** "+ Add" of an empty spot: open the composer on this row's channel and this day. */
  onAdd: (row: CalRow, day: string) => void;
  /** A click on one of the owner's own posts. */
  onOpenPost: (id: string) => void;
}

// ── legend ─────────────────────────────────────────────────────────────────────

const LEGEND: { mark: MarkKind; label: string }[] = [
  { mark: 'published', label: 'Published' },
  { mark: 'planned', label: 'Planned by the agent' },
  { mark: 'awaiting_approval', label: 'Awaiting your approval' },
  { mark: 'not_planned', label: 'Series, not planned yet' },
  { mark: 'missed', label: 'Missed' },
  { mark: 'skipped', label: 'Skipped or paused' },
  { mark: 'failed', label: 'Failed' },
  { mark: 'yours', label: 'Your post' },
];

export function CalLegend() {
  return (
    <ul className="cal-legend" aria-label="What the marks mean">
      {LEGEND.map((l) => (
        <li key={l.mark}><StatusMark status={l.mark} size={12} decorative />{l.label}</li>
      ))}
    </ul>
  );
}

// ── a chip ─────────────────────────────────────────────────────────────────────

/** "no_channel_card" → a sentence a person can act on. */
export function scheduleErrorText(reason: string | null | undefined): string {
  if (!reason) return 'The schedule did not load.';
  if (reason === 'no_channel_card') return 'This agent has no channel card yet, so it has no schedule.';
  if (reason === 'http_404') return 'The schedule is not available on this server.';
  if (reason.startsWith('http_5')) return 'The server failed while building the schedule.';
  return `The schedule did not load (${reason.replace(/_/g, ' ')}).`;
}

export function ChipView({ chip, onOpenPost }: { chip: CalChip; onOpenPost: (id: string) => void }) {
  const cls = `cal-chip is-${chip.mark.replace(/_/g, '-')}${chip.muted ? ' is-muted' : ''}${chip.alert ? ` is-alert-${chip.alert}` : ''}`;
  const body = (
    <>
      <span className="cal-time">{chip.time}</span>
      <span className="cal-title">{chip.title}</span>
      <span className="cal-status">
        <StatusMark status={chip.mark} size={12} decorative />
        <span>{chip.status}</span>
      </span>
    </>
  );
  if (chip.target?.type === 'slot') {
    return <Link to="/app/editor/slot/$id" params={{ id: chip.target.id }} className={cls} aria-label={chip.tip} title={chip.tip}>{body}</Link>;
  }
  if (chip.target?.type === 'post') {
    const id = chip.target.id;
    return <button type="button" className={cls} aria-label={chip.tip} title={chip.tip} onClick={() => onOpenPost(id)}>{body}</button>;
  }
  return <div className={cls} title={chip.tip}>{body}</div>;
}

function AddButton({ row, day, onAdd }: { row: CalRow; day: string; onAdd: GridHandlers['onAdd'] }) {
  return (
    <button type="button" className="cal-add" aria-label={addLabel(row, day)} onClick={() => onAdd(row, day)}>
      <Icon name="plus" size={12} /> Add
    </button>
  );
}

// ── the row head ───────────────────────────────────────────────────────────────

function RowGlyph({ row, size }: { row: CalRow; size: number }) {
  return (
    <HubGlyph size={size} tone={row.kind === 'agent' ? 'accent' : 'neutral'}>
      {row.kind === 'other' ? <Icon name="ellipsis" size={Math.round(size * 0.55)} /> : row.emoji ?? row.name.trim().charAt(0).toUpperCase()}
    </HubGlyph>
  );
}

function RowName({ row }: { row: CalRow }) {
  return row.handle
    ? <Link to="/app/agents/$handle" params={{ handle: row.handle }} className="cal-lh-name">{row.name}</Link>
    : <span className="cal-lh-name">{row.name}</span>;
}

function RowNotes({ row }: { row: CalRow }) {
  if (row.kind !== 'agent' && row.state !== 'error') return null;
  return (
    <div className="cal-lh-note">
      {row.mode && <Badge tone={MODE_TONE[row.mode]}>{MODE_LABEL[row.mode]}</Badge>}
      {row.paused && <Badge tone="warning">Paused</Badge>}
      {row.state === 'error' && <Badge tone="danger" title={scheduleErrorText(row.error)}>Schedule unavailable</Badge>}
    </div>
  );
}

// ── the week grid ──────────────────────────────────────────────────────────────

function Cell({ row, day, today, chips, last, expanded, toggle, handlers }: {
  row: CalRow; day: string; today: string; chips: CalChip[]; last: boolean; expanded: boolean; toggle: () => void; handlers: GridHandlers;
}) {
  const { shown, hidden } = visibleChips(chips, expanded);
  const past = day < today;
  return (
    <div role="cell" aria-label={`${row.name}, ${dayLabel(day)}`} aria-busy={row.state === 'loading' || undefined}
      className={`cal-cell${past ? ' is-past' : ''}${day === today ? ' is-today' : ''}${last ? ' is-last' : ''}`}>
      {shown.map((c) => <ChipView key={c.key} chip={c} onOpenPost={handlers.onOpenPost} />)}
      {hidden > 0 && (
        <button type="button" className="cal-more" aria-expanded={false} onClick={toggle}>{`+${hidden} more`}</button>
      )}
      {expanded && chips.length > CELL_CHIPS && (
        <button type="button" className="cal-more" aria-expanded onClick={toggle}>Show fewer</button>
      )}
      {!past && <AddButton row={row} day={day} onAdd={handlers.onAdd} />}
    </div>
  );
}

export function WeekGrid({ rows, days, today, onAdd, onOpenPost }: { rows: CalRow[]; days: string[] } & { today: string } & GridHandlers) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const flip = (k: string) => setOpen((prev) => { const next = new Set(prev); if (!next.delete(k)) next.add(k); return next; });
  return (
    <div className="cal-scroll">
      <div className="cal-grid" role="table" aria-label="Calendar, agents by day" aria-rowcount={rows.length + 1} aria-colcount={days.length + 1}>
        <div role="row" className="cal-row">
          <div role="columnheader" className="cal-hd"><span className="text-micro ink-dim">Channel</span></div>
          {days.map((day) => {
            const p = dayParts(day);
            return (
              <div key={day} role="columnheader" className={`cal-hd${day === today ? ' is-today' : ''}`} aria-current={day === today ? 'date' : undefined}
                aria-label={day === today ? `${dayLabel(day)}, today` : dayLabel(day)}>
                <span>{p.wd}</span><span className="cal-dn">{p.n}</span>
              </div>
            );
          })}
        </div>
        {rows.map((row, ri) => (
          <div role="row" className="cal-row" key={row.key}>
            <div role="rowheader" className={`cal-lh${ri === rows.length - 1 ? ' is-last' : ''}`}>
              <RowGlyph row={row} size={30} />
              <div className="cal-lh-text">
                <RowName row={row} />
                <div className="cal-lh-sub mono">{row.sub}</div>
                <RowNotes row={row} />
              </div>
            </div>
            {days.map((day, di) => {
              const k = `${row.key}:${day}`;
              return (
                <Cell key={day} row={row} day={day} today={today} chips={row.cells[di] ?? []} last={ri === rows.length - 1}
                  expanded={open.has(k)} toggle={() => flip(k)} handlers={{ onAdd, onOpenPost }} />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── the day agenda (phones) ────────────────────────────────────────────────────

export function DayAgenda({ rows, days, today, onAdd, onOpenPost }: { rows: CalRow[]; days: string[]; today: string } & GridHandlers) {
  return (
    <div className="cal-agenda" role="list" aria-label="Calendar by day">
      {days.map((day, di) => (
        <div role="listitem" key={day}>
          <SectionCard
            title={dayLabel(day)} flush
            action={day === today ? <Badge tone="accent">Today</Badge> : undefined}
          >
            {rows.map((row) => {
              const chips = row.cells[di] ?? [];
              const past = day < today;
              return (
                <div key={row.key} className={`cal-agenda-row${chips.length === 0 ? ' is-empty' : ''}`} aria-busy={row.state === 'loading' || undefined}>
                  <div className="cal-agenda-who">
                    <RowGlyph row={row} size={26} />
                    <div className="cal-lh-text">
                      <RowName row={row} />
                      {row.state === 'error' && <div className="text-micro ink-danger">{scheduleErrorText(row.error)}</div>}
                    </div>
                  </div>
                  {chips.map((c) => <ChipView key={c.key} chip={c} onOpenPost={onOpenPost} />)}
                  {!past && <AddButton row={row} day={day} onAdd={onAdd} />}
                  {past && chips.length === 0 && <span className="cal-cell-msg">Nothing</span>}
                </div>
              );
            })}
          </SectionCard>
        </div>
      ))}
    </div>
  );
}
