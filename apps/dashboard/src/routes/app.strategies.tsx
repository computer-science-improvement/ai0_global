// apps/dashboard/src/routes/strategies.tsx
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Icon } from '../components/Icon';
import { Icon as PlatformGlyph, type IconName } from '../components/ui/Icon';
import { Badge } from '../components/ui/Badge';
import { PageHeader } from '../components/ui/PageHeader';
import { SectionCard, EmptyState, StatusDot, type Tone } from '../components/ui/primitives';
import { TableAction, RowActions } from '../components/ui/table';
import { usePlatform } from '../lib/usePlatform';
import { PlatformFilter } from '../components/PlatformFilter';
import { useConfirm } from '../components/ui/ConfirmDialog';
import {
  useStrategies, usePatchStrategy, useDeleteStrategy, useStrategyRuns, useStrategyPreview,
} from '../api/strategies';
import {
  STRATEGY_STATUS_HELP, RUN_STATUS_HELP, STRATEGY_ROLE_HELP, describeStrategy, SOURCE_KIND_LABEL,
} from '../lib/labels';
import type { Strategy, StrategyRunSummary, PreviewItem } from '../api/types';

export const Route = createFileRoute('/app/strategies')({ component: StrategiesPage });

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
  const [expanded, setExpanded] = useState<string | null>(null);

  // Icons show only on the "All" tab; the "Meta" tab filters to native-Meta
  // strategies; the "Telegram" tab to strategies that publish to Telegram
  // (native-Meta bindings no longer publish to Telegram, so they're excluded).
  const showIcons = platform === 'all';
  const rows = (data ?? []).filter(s =>
    platform === 'meta'     ? s.platforms.some(p => META_PLATFORMS.includes(p))
    : platform === 'telegram' ? s.platforms.includes('telegram')
    : true,
  );

  return (
    <div>
      <PageHeader
        title="Strategies"
        subtitle="Cron-scheduled content generators bound to channels. Click a row to see its execution log."
        actions={
          <Link to={'/app/strategies/new' as never} className="btn-primary" style={{ gap: 6, display: 'inline-flex', alignItems: 'center' }}>
            <Icon name="plus" size={14} /> Add strategy
          </Link>
        }
      />

      {/* Destination filter — strategies are the only view this affects. */}
      <div style={{ marginBottom: 20 }}>
        <PlatformFilter />
      </div>

      {isLoading && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>}
      {error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(error as Error).message}</p>}

      {data && rows.length === 0 && (
        <EmptyState
          icon="strategies"
          title={platform === 'meta' ? 'No Meta-enabled strategies' : 'No strategies yet'}
          note={platform === 'meta'
            ? 'Add a cross-post target on a strategy (Edit → Cross-post) to surface it here.'
            : 'Add one to start scheduled publishing.'}
        />
      )}

      {data && rows.length > 0 && (
        <SectionCard title="Strategies" icon="strategies" delay={60}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {rows.map((s, i) => {
              const isOpen = expanded === s.id;
              return (
                <div key={s.id}>
                  <StrategyRow
                    s={s}
                    index={i}
                    showIcons={showIcons}
                    open={isOpen}
                    onToggleOpen={() => setExpanded(isOpen ? null : s.id)}
                    onToggle={() => patch.mutate({ id: s.id, patch: { enabled: !s.enabled } })}
                    onDelete={async () => {
                      if (await confirm(`delete strategy ${s.ext_id}`)) remove.mutate(s.id);
                    }}
                  />
                  {isOpen && (
                    <div
                      className="compose-rise"
                      style={{
                        marginTop: 8,
                        border: '1px solid var(--color-hairline)',
                        borderRadius: 'var(--radius-md)',
                        background: 'var(--color-canvas)',
                        overflow: 'hidden',
                      }}
                    >
                      <ExpandedDetails strategy={s} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </SectionCard>
      )}
    </div>
  );
}

function StrategyRow({
  s, index, showIcons, open, onToggleOpen, onToggle, onDelete,
}: {
  s: Strategy; index: number; showIcons: boolean; open: boolean; onToggleOpen: () => void;
  onToggle: () => void; onDelete: () => void;
}) {
  const m = describeStrategy(s.type);
  const typeTip = m ? `${m.title} (${SOURCE_KIND_LABEL[m.source]})\n\n${m.description}` : s.type;
  // Status dot is the at-a-glance signal: paused → neutral, last error → danger,
  // otherwise healthy/enabled → success.
  const dotTone: Tone = !s.enabled ? 'neutral' : s.last_run?.status === 'error' ? 'danger' : 'success';

  return (
    <div
      className="card row-lift compose-rise"
      style={{
        display: 'flex', alignItems: 'center', gap: 16,
        padding: '13px 18px', cursor: 'pointer',
        animationDelay: `${Math.min(index, 12) * 34}ms`,
      }}
      onClick={onToggleOpen}
    >
      {/* Expand chevron */}
      <Icon
        name="chevron-right" size={14}
        style={{
          flexShrink: 0, color: 'var(--color-ink-muted)',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.12s ease',
        }}
      />

      {/* Status dot */}
      <span style={{ display: 'inline-flex', flexShrink: 0 }}
        title={s.enabled ? STRATEGY_STATUS_HELP.enabled : STRATEGY_STATUS_HELP.paused}>
        <StatusDot tone={dotTone} />
      </span>

      {/* Identity + destination */}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="text-body" style={{ color: 'var(--color-ink)', fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
            {s.ext_id}
          </span>
          <span className="chip" title={typeTip}>{s.type}</span>
          {showIcons && <PlatformIcons platforms={s.platforms} />}
          {!s.enabled && <span className="chip" title={STRATEGY_STATUS_HELP.paused}>paused</span>}
          {s.needs_bot && (
            <span title="This channel has no bot bound and no default bot exists, so this strategy cannot publish.">
              <Badge tone="warning">
                <Icon name="warning" size={11} /> No bot
              </Badge>
            </span>
          )}
        </div>

        {/* Meta line — destination · schedule · next run */}
        <div className="text-micro" style={{
          color: 'var(--color-ink-muted)', marginTop: 4,
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        }}>
          {s.channel_key ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <PlatformGlyph name={PLATFORM_GLYPH[s.platform] ?? 'telegram'} size={12} className="" />
              {s.channel_key}
            </span>
          ) : s.meta_account ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <PlatformGlyph name={PLATFORM_GLYPH[s.meta_account.platform] ?? 'instagram'} size={12} className="" />
              {s.meta_account.username ? '@' + s.meta_account.username : s.meta_account.platform}
            </span>
          ) : (
            <span style={{ color: 'var(--color-ink-dim)' }}>no destination</span>
          )}
          <span style={{ color: 'var(--color-ink-dim)' }}>·</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }} title="Cron schedule">{s.schedule}</span>
          {s.enabled && s.next_run_at && (
            <>
              <span style={{ color: 'var(--color-ink-dim)' }}>·</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }} title="Next scheduled run">
                next {formatRelative(s.next_run_at)}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Last run + actions */}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 14 }} onClick={(e) => e.stopPropagation()}>
        <LastRunCell last={s.last_run} />
        <RowActions>
          <Link
            to={'/app/strategies/$id' as never}
            params={{ id: s.id } as never}
            className="btn-act"
            title="Edit strategy + see example post"
            aria-label="Edit strategy"
          >
            <PlatformGlyph name="pencil" size={14} />
          </Link>
          <TableAction
            action={s.enabled ? 'pause' : 'enable'}
            onClick={onToggle}
          />
          <span className="row-actions-sep" aria-hidden />
          <TableAction action="delete" onClick={onDelete} />
        </RowActions>
      </div>
    </div>
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
      {last.status === 'ok' ? (
        <Badge tone="success" title={tooltip}>
          <Icon name="check"  size={12} style={{ marginRight: 4 }} />{last.status}
        </Badge>
      ) : last.status === 'error' ? (
        <Badge tone="danger" title={tooltip}>
          <Icon name="warning" size={12} style={{ marginRight: 4 }} />{last.status}
        </Badge>
      ) : last.status === 'skipped' ? (
        <Badge tone="warning" title={tooltip}>{last.status}</Badge>
      ) : (
        <Badge tone="neutral" title={tooltip}>{last.status}</Badge>
      )}
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
            {c.role === 'primary' ? (
              <Badge tone="success" title={STRATEGY_ROLE_HELP[c.role]} style={{ minWidth: 64, justifyContent: 'center' }}>
                {c.role}
              </Badge>
            ) : (
              <span className="chip" style={{ minWidth: 64, justifyContent: 'center' }} title={STRATEGY_ROLE_HELP[c.role]}>
                {c.role}
              </span>
            )}
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
              {r.status === 'ok' ? (
                <Badge tone="success" title={RUN_STATUS_HELP[r.status] ?? r.status}>{r.status}</Badge>
              ) : r.status === 'error' ? (
                <Badge tone="danger" title={RUN_STATUS_HELP[r.status] ?? r.status}>{r.status}</Badge>
              ) : r.status === 'skipped' ? (
                <Badge tone="warning" title={RUN_STATUS_HELP[r.status] ?? r.status}>{r.status}</Badge>
              ) : (
                <Badge tone="neutral" title={RUN_STATUS_HELP[r.status] ?? r.status}>{r.status}</Badge>
              )}
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
