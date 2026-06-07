// apps/dashboard/src/routes/strategies.tsx
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { Icon } from '../components/Icon';
import { Icon as PlatformGlyph, type IconName } from '../components/ui/Icon';
import { usePlatform } from '../lib/usePlatform';
import { AddStrategyModal } from '../components/AddStrategyModal';
import { EditStrategyModal } from '../components/EditStrategyModal';
import { useConfirm } from '../components/ui/ConfirmDialog';
import {
  useStrategies, usePatchStrategy, useDeleteStrategy, useStrategyRuns, useStrategyPreview,
} from '../api/strategies';
import {
  STRATEGY_STATUS_HELP, RUN_STATUS_HELP, STRATEGY_ROLE_HELP, describeStrategy, SOURCE_KIND_LABEL,
} from '../lib/labels';
import type { Strategy, StrategyRunSummary, PreviewItem } from '../api/types';

export const Route = createFileRoute('/strategies')({ component: StrategiesPage });

const META_PLATFORMS = ['instagram', 'facebook', 'threads'];
const PLATFORM_GLYPH: Record<string, IconName> = {
  telegram: 'telegram', instagram: 'instagram', facebook: 'facebook', threads: 'threads',
};

/** Platform capability icons for a strategy row (shown only on the "All" tab). */
function PlatformIcons({ platforms }: { platforms: string[] }) {
  const order = ['telegram', 'instagram', 'facebook', 'threads'].filter(p => platforms.includes(p));
  return (
    <span style={{ display: 'inline-flex', gap: 5, marginLeft: 8, verticalAlign: 'middle' }}>
      {order.map(p => (
        <PlatformGlyph key={p} name={PLATFORM_GLYPH[p]} size={13}
          className="" />
      ))}
    </span>
  );
}

function StrategiesPage() {
  const { data, isLoading, error } = useStrategies();
  const [platform] = usePlatform();
  const patch  = usePatchStrategy();
  const remove = useDeleteStrategy();
  const confirm = useConfirm();
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Strategy | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Icons show only on the "All" tab; the "Meta" tab filters to Meta-capable
  // strategies; "Telegram" shows all (every strategy publishes to Telegram).
  const showIcons = platform === 'all';
  const rows = (data ?? []).filter(s =>
    platform === 'meta' ? s.platforms.some(p => META_PLATFORMS.includes(p)) : true,
  );

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

      {data && rows.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 48 }}>
          <p className="text-body" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>
            {platform === 'meta'
              ? 'No Meta-enabled strategies — add a cross-post target on a strategy (Edit → Cross-post).'
              : 'No strategies yet — add one to start scheduled publishing.'}
          </p>
        </div>
      )}

      {data && rows.length > 0 && (
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
              {rows.map(s => {
                const isOpen = expanded === s.id;
                return (
                  <>
                    <StrategyRow
                      key={s.id}
                      s={s}
                      showIcons={showIcons}
                      open={isOpen}
                      onToggleOpen={() => setExpanded(isOpen ? null : s.id)}
                      onEdit={() => setEditing(s)}
                      onToggle={() => patch.mutate({ id: s.id, patch: { enabled: !s.enabled } })}
                      onDelete={async () => {
                        if (await confirm(`delete strategy ${s.ext_id}`)) remove.mutate(s.id);
                      }}
                    />
                    {isOpen && (
                      <tr key={s.id + '-details'}>
                        <td colSpan={9} style={{ padding: 0, background: 'var(--color-canvas)' }}>
                          <ExpandedDetails strategy={s} />
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
      {editing && (
        <EditStrategyModal
          strategy={editing}
          open={!!editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function StrategyRow({ s, showIcons, open, onToggleOpen, onEdit, onToggle, onDelete }: {
  s: Strategy; showIcons: boolean; open: boolean; onToggleOpen: () => void; onEdit: () => void; onToggle: () => void; onDelete: () => void;
}) {
  return (
    <tr style={{ cursor: 'pointer' }} onClick={onToggleOpen}>
      <td style={{ color: 'var(--color-ink-muted)' }}>
        <Icon name={open ? 'chevron-right' : 'chevron-right'} size={14}
          style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.12s ease' }} />
      </td>
      <td style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--color-ink)' }}>{s.ext_id}</td>
      <td>
        <span
          className="chip"
          title={(() => {
            const m = describeStrategy(s.type);
            return m ? `${m.title} (${SOURCE_KIND_LABEL[m.source]})\n\n${m.description}` : s.type;
          })()}
        >
          {s.type}
        </span>
        {showIcons && <PlatformIcons platforms={s.platforms} />}
      </td>
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
          ? <span className="chip chip-success" title={STRATEGY_STATUS_HELP.enabled}>
              <Icon name="check" size={12} style={{ marginRight: 4 }} />enabled
            </span>
          : <span className="chip" title={STRATEGY_STATUS_HELP.paused}>paused</span>}
      </td>
      <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'inline-flex', gap: 6 }}>
          <button onClick={onEdit} className="btn-tiny" title="Edit schedule, params, channel…">
            <Icon name="pencil" size={12} style={{ marginRight: 4 }} />
            Edit
          </button>
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
  if (!last) return <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }} title="No execution recorded for this strategy yet.">never</span>;
  const ago = formatRelativePast(last.started_at);
  const meta = last.duration_ms ? `${(last.duration_ms / 1000).toFixed(1)}s` : null;
  const help = RUN_STATUS_HELP[last.status] ?? last.status;
  const tooltip = last.error ? `${help}\n\n${last.error}` : help;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span className={
        last.status === 'ok'      ? 'chip chip-success' :
        last.status === 'error'   ? 'chip chip-danger'  :
        last.status === 'skipped' ? 'chip chip-warning' :
        'chip'
      } title={tooltip}>
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

/**
 * Expanded panel under a strategy row. Three sections side-by-side:
 *  • Channels — primary + forward targets this strategy publishes into
 *  • Preview  — what content the next fire would draw from (Phase D, separate component)
 *  • Runs     — last 20 execution rows
 */
function ExpandedDetails({ strategy }: { strategy: Strategy }) {
  return (
    <div style={{ padding: '14px 24px 18px', background: 'var(--color-canvas)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <ChannelsPanel strategy={strategy} />
        <PreviewPanel strategyId={strategy.id} />
      </div>
      <RunsPanel strategyId={strategy.id} />
    </div>
  );
}

function ChannelsPanel({ strategy }: { strategy: Strategy }) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <div className="text-eyebrow" style={{ marginBottom: 10 }}>Channels reached</div>
      {strategy.channels.length === 0 && (
        <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>
          No channels resolved — primary binding may be misconfigured.
        </p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {strategy.channels.map(c => (
          <div
            key={c.id}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 12px',
              background: 'var(--color-surface-2)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <span
              className={c.role === 'primary' ? 'chip chip-success' : 'chip'}
              style={{ minWidth: 64, justifyContent: 'center' }}
              title={STRATEGY_ROLE_HELP[c.role]}
            >
              {c.role}
            </span>
            <span className="text-body-sm" style={{ color: 'var(--color-ink)' }}>
              {c.title ?? c.channel_key ?? c.id}
            </span>
            {c.channel_key && c.channel_key !== c.title && (
              <span className="text-micro" style={{ color: 'var(--color-ink-muted)', marginLeft: 'auto' }}>
                {c.channel_key}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PreviewPanel({ strategyId }: { strategyId: string }) {
  const { data, isLoading, error } = useStrategyPreview(strategyId);

  return (
    <div className="card" style={{ padding: 16 }}>
      <div className="text-eyebrow" style={{ marginBottom: 10 }}>Next-up preview</div>
      {isLoading && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>Loading…</p>}
      {error && <p className="text-body-sm" style={{ color: 'var(--color-danger)', margin: 0 }}>{(error as Error).message}</p>}
      {data && data.kind === 'unsupported' && (
        <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>
          {data.message ?? 'No preview available for this strategy type.'}
        </p>
      )}
      {data && data.kind !== 'unsupported' && data.items.length === 0 && (
        <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>
          {data.message ?? 'No sample data found.'}
        </p>
      )}
      {data && data.items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {data.items.slice(0, 3).map((it, i) => (
            <PreviewItemCard key={i} item={it} />
          ))}
          {data.message && (
            <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: 0 }}>
              {data.message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function PreviewItemCard({ item }: { item: PreviewItem }) {
  return (
    <div
      style={{
        display: 'flex', gap: 10,
        padding: 10,
        background: 'var(--color-surface-2)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      {item.imageUrl && (
        <img
          src={item.imageUrl}
          alt={item.imageAlt ?? ''}
          style={{
            width: 64, height: 64, objectFit: 'cover',
            borderRadius: 'var(--radius-sm)',
            flexShrink: 0,
          }}
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        {item.title && (
          <div className="text-body-sm" style={{ color: 'var(--color-ink)', fontWeight: 500 }}>
            {item.title}
          </div>
        )}
        {item.text && (
          <p className="text-micro" style={{ color: 'var(--color-ink-muted)', margin: '4px 0 0',
            display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          } as React.CSSProperties}>
            {item.text}
          </p>
        )}
        {(item.source || item.url) && (
          <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginTop: 4 }}>
            {item.source}
            {item.url && (
              <>
                {item.source ? ' · ' : ''}
                <a href={item.url} className="link-accent" target="_blank" rel="noopener noreferrer">link</a>
              </>
            )}
          </div>
        )}
      </div>
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
              <span
                className={
                  r.status === 'ok'      ? 'chip chip-success' :
                  r.status === 'error'   ? 'chip chip-danger'  :
                  r.status === 'skipped' ? 'chip chip-warning' :
                  'chip'
                }
                title={RUN_STATUS_HELP[r.status] ?? r.status}
              >
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
