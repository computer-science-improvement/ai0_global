// apps/dashboard/src/routes/strategies.tsx
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { Icon } from '../components/Icon';
import { AddStrategyModal } from '../components/AddStrategyModal';
import {
  useStrategies, usePatchStrategy, useDeleteStrategy, useStrategyRuns,
} from '../api/strategies';
import type { Strategy, StrategyRunSummary } from '../api/types';

export const Route = createFileRoute('/strategies')({ component: StrategiesPage });

function StrategiesPage() {
  const { data, isLoading, error } = useStrategies();
  const patch  = usePatchStrategy();
  const remove = useDeleteStrategy();
  const [addOpen, setAddOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 className="text-display-md" style={{ margin: 0 }}>Strategies</h1>
          <p className="text-caption" style={{ margin: '6px 0 0', color: 'var(--color-ink-muted)' }}>
            Cron-scheduled content generators bound to channels. Click a row to see its execution log.
          </p>
        </div>
        <button onClick={() => setAddOpen(true)} className="btn-primary" style={{ gap: 6 }}>
          <Icon name="plus" size={14} /> Add strategy
        </button>
      </header>

      {isLoading && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>}
      {error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(error as Error).message}</p>}

      {data && data.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 48 }}>
          <p className="text-body" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>
            No strategies yet — add one to start scheduled publishing.
          </p>
        </div>
      )}

      {data && data.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 30 }}></th>
                <th>Id</th>
                <th>Type</th>
                <th>Channel</th>
                <th>Schedule</th>
                <th>Next run</th>
                <th>Last run</th>
                <th>Status</th>
                <th style={{ width: 200, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.map(s => {
                const isOpen = expanded === s.id;
                return (
                  <>
                    <StrategyRow
                      key={s.id}
                      s={s}
                      open={isOpen}
                      onToggleOpen={() => setExpanded(isOpen ? null : s.id)}
                      onToggle={() => patch.mutate({ id: s.id, patch: { enabled: !s.enabled } })}
                      onDelete={() => {
                        if (confirm(`Delete strategy ${s.ext_id}?`)) remove.mutate(s.id);
                      }}
                    />
                    {isOpen && (
                      <tr key={s.id + '-runs'}>
                        <td colSpan={9} style={{ padding: 0, background: 'var(--color-canvas)' }}>
                          <RunsPanel strategyId={s.id} />
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <AddStrategyModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}

function StrategyRow({ s, open, onToggleOpen, onToggle, onDelete }: {
  s: Strategy; open: boolean; onToggleOpen: () => void; onToggle: () => void; onDelete: () => void;
}) {
  return (
    <tr style={{ cursor: 'pointer' }} onClick={onToggleOpen}>
      <td style={{ color: 'var(--color-ink-muted)' }}>
        <Icon name={open ? 'chevron-right' : 'chevron-right'} size={14}
          style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.12s ease' }} />
      </td>
      <td style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--color-ink)' }}>{s.ext_id}</td>
      <td><span className="chip">{s.type}</span></td>
      <td style={{ color: 'var(--color-ink-muted)' }}>
        {s.channel_key ?? <span style={{ color: 'var(--color-ink-dim)' }}>—</span>}
      </td>
      <td style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--color-ink-muted)' }}>{s.schedule}</td>
      <td>
        {s.enabled && s.next_run_at
          ? <span className="text-body-sm" style={{ color: 'var(--color-ink)', fontVariantNumeric: 'tabular-nums' }}>
              {formatRelative(s.next_run_at)}
            </span>
          : <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>—</span>}
      </td>
      <td>
        <LastRunCell last={s.last_run} />
      </td>
      <td>
        {s.enabled
          ? <span className="chip chip-success"><Icon name="check" size={12} style={{ marginRight: 4 }} />enabled</span>
          : <span className="chip">paused</span>}
      </td>
      <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'inline-flex', gap: 6 }}>
          <button onClick={onToggle} className="btn-tiny">
            {s.enabled
              ? <><Icon name="pause" size={12} style={{ marginRight: 4 }} />Pause</>
              : <><Icon name="play"  size={12} style={{ marginRight: 4 }} />Enable</>}
          </button>
          <button onClick={onDelete} className="btn-tiny-danger">
            <Icon name="trash" size={12} style={{ marginRight: 4 }} />
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

function LastRunCell({ last }: { last: StrategyRunSummary | null }) {
  if (!last) return <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>never</span>;
  const ago = formatRelativePast(last.started_at);
  const meta = last.duration_ms ? `${(last.duration_ms / 1000).toFixed(1)}s` : null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span className={
        last.status === 'ok'      ? 'chip chip-success' :
        last.status === 'error'   ? 'chip chip-danger'  :
        last.status === 'skipped' ? 'chip chip-warning' :
        'chip'
      } title={last.error ?? last.status}>
        {last.status === 'ok' && <Icon name="check"  size={12} style={{ marginRight: 4 }} />}
        {last.status === 'error' && <Icon name="warning" size={12} style={{ marginRight: 4 }} />}
        {last.status}
      </span>
      <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>
        {ago}{meta && ` · ${meta}`}
      </span>
    </div>
  );
}

function RunsPanel({ strategyId }: { strategyId: string }) {
  const { data, isLoading } = useStrategyRuns(strategyId);

  return (
    <div style={{ padding: '12px 24px 16px', background: 'var(--color-canvas)' }}>
      <div className="text-eyebrow" style={{ marginBottom: 10 }}>Execution log · last 20 runs</div>
      {isLoading && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>Loading…</p>}
      {data && data.length === 0 && (
        <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>
          No runs recorded yet. The first execution will appear here.
        </p>
      )}
      {data && data.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {data.map(r => (
            <div
              key={r.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '120px 100px 80px 1fr',
                gap: 12,
                alignItems: 'center',
                padding: '8px 12px',
                background: 'var(--color-surface-1)',
                borderRadius: 'var(--radius-md)',
                fontSize: 13,
              }}
            >
              <span style={{ color: 'var(--color-ink-muted)', fontVariantNumeric: 'tabular-nums' }}>
                {formatRelativePast(r.started_at)}
              </span>
              <span className={
                r.status === 'ok'      ? 'chip chip-success' :
                r.status === 'error'   ? 'chip chip-danger'  :
                r.status === 'skipped' ? 'chip chip-warning' :
                'chip'
              }>
                {r.status}
              </span>
              <span style={{ color: 'var(--color-ink-muted)', fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
                {r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—'}
              </span>
              <span style={{ color: r.error ? 'var(--color-danger)' : 'var(--color-ink-dim)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.error ?? new Date(r.started_at).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Future timestamp → relative string. */
function formatRelative(iso: string): string {
  const t  = new Date(iso).getTime();
  const dt = t - Date.now();
  if (dt < 0) return 'now';
  const m = Math.round(dt / 60_000);
  if (m < 60)   return `in ${m}m`;
  const h = Math.floor(m / 60);
  const mm = m - h * 60;
  if (h < 24)   return `in ${h}h ${mm}m`;
  const d = Math.floor(h / 24);
  return `in ${d}d ${h - d * 24}h`;
}

/** Past timestamp → relative string. */
function formatRelativePast(iso: string): string {
  const t  = new Date(iso).getTime();
  const dt = Date.now() - t;
  if (dt < 0) return 'now';
  const m = Math.round(dt / 60_000);
  if (m < 1)    return 'just now';
  if (m < 60)   return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)   return `${h}h ${m - h * 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h - d * 24}h ago`;
}
