import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { Crumbs } from '../components/ui/Crumbs';
import { useCrumbs } from '../nav/hooks';
import { Panel } from '../components/ui/Card';
import { Icon } from '../components/Icon';
import { TelegramPreview } from '../components/post/TelegramPreview';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { Badge } from '../components/ui/Badge';
import { CrosspostSection } from '../components/CrosspostSection';
import { useStrategies, useStrategyPreview, usePatchStrategy, useRecipePostPreview } from '../api/strategies';
import type { CaptionPart } from '../api/strategies';
import {
  STRATEGY_STATUS_HELP, RUN_STATUS_HELP, describeStrategy, SOURCE_KIND_LABEL,
} from '../lib/labels';
import { fmtDate } from '../lib/format';
import type { ComposedPostInput, PreviewItem, Strategy } from '../api/types';

export const Route = createFileRoute('/app/strategies_/$id')({ component: StrategyDetailPage });

const LOREM_TEXT =
  '<b>Lorem ipsum dolor sit amet</b>\n\nConsectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation…';

function StrategyDetailPage() {
  const { id } = Route.useParams();
  const { data: strategies, isLoading, error } = useStrategies();
  const s = (strategies ?? []).find(x => x.id === id);
  const crumbs = useCrumbs('strategy-detail');

  return (
    <div>
      <Crumbs crumbs={crumbs} />

      {isLoading && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>}
      {error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(error as Error).message}</p>}
      {strategies && !s && (
        <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>
          Strategy not found — it may have been deleted.
        </p>
      )}

      {s && <StrategyDetail strategy={s} />}
    </div>
  );
}

function StrategyDetail({ strategy: s }: { strategy: Strategy }) {
  const meta = describeStrategy(s.type);

  return (
    <div>
      <PageHeader
        title={s.ext_id}
        subtitle={meta ? `${meta.title} (${s.type})` : s.type}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))', gap: 16, alignItems: 'start' }}>
        <LegacyPanel strategy={s} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <ConfigPanel strategy={s} meta={meta} />
          <ExamplePostPanel strategyId={s.id} />
          {s.type === 'recipe-carousel' && (
            <PostPreviewPanel strategy={s} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Read-only configuration summary: type/destination/schedule/status/last-run. */
function ConfigPanel({ strategy: s, meta }: { strategy: Strategy; meta: ReturnType<typeof describeStrategy> }) {
  return (
    <Panel title="Configuration">
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '10px 16px', margin: 0 }}>
        <Term>Type</Term>
        <Def>
          <span className="chip" title={meta ? `${meta.title} (${SOURCE_KIND_LABEL[meta.source]})\n\n${meta.description}` : s.type}>
            {s.type}
          </span>
        </Def>

        <Term>Destination</Term>
        <Def>{destinationLabel(s)}</Def>

        <Term>Schedule</Term>
        <Def><span style={{ fontVariantNumeric: 'tabular-nums' }}>{s.schedule}</span></Def>

        <Term>Status</Term>
        <Def>
          {s.enabled
            ? <span title={STRATEGY_STATUS_HELP.enabled}>
                <Badge tone="success"><Icon name="check" size={12} /> enabled</Badge>
              </span>
            : <span title={STRATEGY_STATUS_HELP.paused}><Badge tone="neutral">paused</Badge></span>}
        </Def>

        <Term>Last run</Term>
        <Def>
          {s.last_run ? (
            <span title={(RUN_STATUS_HELP[s.last_run.status] ?? s.last_run.status) + (s.last_run.error ? `\n\n${s.last_run.error}` : '')}>
              <Badge tone={
                s.last_run.status === 'ok'      ? 'success' :
                s.last_run.status === 'error'   ? 'danger'  :
                s.last_run.status === 'skipped' ? 'warning' :
                'neutral'
              }>
                {s.last_run.status}
              </Badge>
            </span>
          ) : <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>never</span>}
        </Def>
      </dl>
    </Panel>
  );
}

/**
 * Spec 023 FR-013 phase A: a strategy is read-only legacy. Only pausing and notes can change (the API refuses
 * the rest with 410); a retired strategy links to the agent series that replaced it.
 */
function LegacyPanel({ strategy: s }: { strategy: Strategy }) {
  const patch = usePatchStrategy();
  const [notes, setNotes] = useState(s.notes ?? '');
  const [saved, setSaved] = useState(false);
  useEffect(() => { setNotes(s.notes ?? ''); setSaved(false); }, [s.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const retired = !!s.retired_at;

  const save = async (body: { enabled?: false; notes?: string | null }) => {
    setSaved(false);
    try {
      await patch.mutateAsync({ id: s.id, patch: body });
      setSaved(true);
    } catch { /* error rendered inline */ }
  };

  return (
    <Panel title="Legacy strategy">
      {retired ? (
        <div className="callout-warning" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
          <Icon name="info" size={14} />
          <span className="text-micro">
            Retired {fmtDate(s.retired_at!)}: the agent&apos;s series took over.{' '}
            {s.migrated_to?.handle && (
              <Link to={'/app/agents/$handle' as never} params={{ handle: s.migrated_to.handle } as never} search={{ tab: 'schedule' } as never} className="link-accent">
                {s.migrated_to.series?.length ? `Series ${s.migrated_to.series.join(', ')}` : 'Schedule'} of @{s.migrated_to.handle} →
              </Link>
            )}
          </span>
        </div>
      ) : (
        <div className="callout-warning" style={{ marginBottom: 16 }}>
          <Icon name="info" size={14} />
          <span className="text-micro">
            Strategies are read-only: you can pause this one and keep notes. To change what or when it publishes, migrate the
            channel to its agent on the <Link to="/app/strategies" className="link-accent">Strategies</Link> page.
          </span>
        </div>
      )}

      <Field label="Name (id)">
        <div className="text-body-sm" style={{ color: 'var(--color-ink)', fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>{s.ext_id}</div>
      </Field>

      <Field label="Destination">
        <div className="text-body-sm" style={{ color: 'var(--color-ink)' }}>{destinationLabel(s)}</div>
      </Field>

      <Field label="Schedule (cron)">
        <div className="text-body-sm" style={{ color: 'var(--color-ink)', fontVariantNumeric: 'tabular-nums' }}>
          {s.schedule}
          {s.enabled && s.next_run_at && (
            <span className="text-micro" style={{ color: 'var(--color-ink-muted)', marginLeft: 8 }}>next {fmtDate(s.next_run_at)}</span>
          )}
        </div>
      </Field>

      <Field label="Params">
        <pre className="text-micro" style={{
          margin: 0, padding: '10px 12px', background: 'var(--color-surface-1)', borderRadius: 'var(--radius-md)',
          color: 'var(--color-ink-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 240, overflowY: 'auto',
        }}>
          {JSON.stringify(s.params ?? {}, null, 2)}
        </pre>
      </Field>

      <Field label="Notes (optional)">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            value={notes}
            onChange={e => { setNotes(e.target.value); setSaved(false); }}
            placeholder="Why does this exist?"
            className="input-field"
            style={{ flex: '1 1 200px', minWidth: 0 }}
          />
          <button
            className="btn-tiny"
            disabled={patch.isPending || notes === (s.notes ?? '')}
            onClick={() => save({ notes: notes.trim() || null })}
          >
            Save notes
          </button>
        </div>
      </Field>

      <Field label="Status">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {retired
            ? <Badge tone="neutral">retired</Badge>
            : s.enabled
              ? <span title={STRATEGY_STATUS_HELP.enabled}><Badge tone="success"><Icon name="check" size={12} /> enabled</Badge></span>
              : <span title={STRATEGY_STATUS_HELP.paused}><Badge tone="neutral">paused</Badge></span>}
          {s.enabled && (
            <button className="btn-tiny" disabled={patch.isPending} onClick={() => save({ enabled: false })} title="Stop this strategy. It cannot be enabled again from here.">
              <Icon name="pause" size={12} /> Pause
            </button>
          )}
        </div>
      </Field>

      {s.platform === 'telegram' && <CrosspostSection channelId={s.channel_id} />}

      {patch.error && (
        <p className="text-body-sm" style={{ color: 'var(--color-danger)', marginBottom: 0, overflowWrap: 'anywhere' }}>{(patch.error as Error).message}</p>
      )}
      {saved && !patch.isPending && (
        <span className="text-micro" style={{ color: 'var(--color-success, var(--color-accent))' }}>
          <Icon name="check" size={12} style={{ marginRight: 4 }} />Saved
        </span>
      )}
    </Panel>
  );
}

function ExamplePostPanel({ strategyId }: { strategyId: string }) {
  const { data, isLoading, error } = useStrategyPreview(strategyId);

  return (
    <Panel title="Example post">
      {isLoading && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>Loading…</p>}
      {error && <p className="text-body-sm" style={{ color: 'var(--color-danger)', margin: 0 }}>{(error as Error).message}</p>}
      {data && <ExampleBody preview={data} />}
    </Panel>
  );
}

function ExampleBody({ preview }: { preview: NonNullable<ReturnType<typeof useStrategyPreview>['data']> }) {
  const hasSample = preview.items.length > 0 && preview.kind !== 'live-fetch' && preview.kind !== 'unsupported';

  if (!hasSample) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <TelegramPreview post={toPost(LOREM_TEXT, undefined)} />
        <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: 0 }}>
          No historical sample for this strategy — showing placeholder format.
        </p>
        {preview.message && (
          <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: 0 }}>{preview.message}</p>
        )}
      </div>
    );
  }

  const first = preview.items[0];
  const caption =
    preview.kind === 'dedup-recent' ? 'Example from recent history'
    : preview.kind === 'db-row'     ? 'Sample from the content pool'
    : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <TelegramPreview post={toPost(itemText(first), first.imageUrl)} />
      {caption && <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: 0 }}>{caption}</p>}
      {preview.message && (
        <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: 0 }}>{preview.message}</p>
      )}
      {preview.items.length > 1 && (
        <div style={{ marginTop: 6 }}>
          <div className="text-eyebrow" style={{ marginBottom: 8 }}>Other recent items</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {preview.items.slice(1, 4).map((it, i) => <PreviewItemCard key={i} item={it} />)}
          </div>
        </div>
      )}
    </div>
  );
}

/** Build the HTML caption for a preview item: bold title (omitted if missing) + body text. */
function itemText(item: PreviewItem): string {
  const body = item.text ?? '';
  if (item.title) return `<b>${escapeHtml(item.title)}</b>${body ? `\n\n${body}` : ''}`;
  return body;
}

/** Map an HTML caption + optional image into the ComposedPostInput shape TelegramPreview expects. */
function toPost(text: string, imageUrl: string | undefined): ComposedPostInput {
  return {
    channelId: '',
    sender: 'bot',
    botId: null,
    text,
    mediaType: imageUrl ? 'photo' : 'none',
    mediaUrl: imageUrl ?? null,
    mediaPlacement: 'above',
    buttons: [],
    scheduledAt: '',
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Post-Preview Panel (recipe-carousel only) ────────────────────────────────

type Platform = 'facebook' | 'instagram' | 'threads' | 'telegram';

const PLATFORM_OPTIONS: ReadonlyArray<{ key: Platform; label: string }> = [
  { key: 'facebook',  label: 'Facebook' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'threads',   label: 'Threads' },
  { key: 'telegram',  label: 'Telegram' },
];

/** Map CaptionPart source to a Badge tone. */
function sourceTone(source: CaptionPart['source']): 'neutral' | 'accent' | 'success' {
  if (source === 'custom') return 'accent';
  if (source === 'generated') return 'success';
  return 'neutral';
}

/** Human-readable source label. */
function sourceLabel(source: CaptionPart['source']): string {
  switch (source) {
    case 'recipe':   return 'recipe DB';
    case 'computed': return 'computed';
    case 'static':   return 'static';
    case 'generated': return 'AI';
    case 'custom':   return 'custom';
  }
}

function PostPreviewPanel({ strategy }: { strategy: Strategy }) {
  const isRecipeCarousel = strategy.type === 'recipe-carousel';
  const { data: preview, isLoading, error } = useRecipePostPreview(strategy.id, isRecipeCarousel);
  const [platform, setPlatform] = useState<Platform>('facebook');

  return (
    <Panel title="Post Preview">
      <div className="callout-warning" style={{ marginBottom: 16 }}>
        <Icon name="info" size={14} />
        <span className="text-micro">
          Read-only: strategies are legacy, so their caption overrides no longer change. Instagram omits the Telegram link.
        </span>
      </div>

      {isLoading && (
        <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>Loading preview…</p>
      )}
      {error && (
        <p className="text-body-sm" style={{ color: 'var(--color-danger)', margin: 0 }}>
          {(error as Error).message}
        </p>
      )}

      {preview && (
        <>
          <div style={{ marginBottom: 16 }}>
            <SegmentedTabs<Platform>
              value={platform}
              onChange={setPlatform}
              options={PLATFORM_OPTIONS}
              size="sm"
            />
          </div>

          <div style={{ marginBottom: 16 }}>
            <div className="text-eyebrow" style={{ marginBottom: 8 }}>Caption parts</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {preview.parts.map(part => {
                const activePlatform = part.platforms.includes(platform);
                return (
                  <div
                    key={part.key}
                    style={{
                      padding: '10px 12px',
                      background:    'var(--color-surface-2)',
                      borderRadius:  'var(--radius-md)',
                      opacity:       activePlatform ? 1 : 0.45,
                      borderLeft:    activePlatform ? '2px solid var(--color-accent)' : '2px solid var(--color-surface-3)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                      <span className="text-micro" style={{ color: 'var(--color-ink-muted)', fontWeight: 600 }}>{part.label}</span>
                      <Badge tone={sourceTone(part.source)}>{sourceLabel(part.source)}</Badge>
                      {!activePlatform && (
                        <span className="text-micro" style={{ color: 'var(--color-ink-dim)', marginLeft: 'auto' }}>not on {platform}</span>
                      )}
                    </div>
                    <div className="text-body-sm" style={{ color: 'var(--color-ink)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                      {part.value || <span style={{ color: 'var(--color-ink-dim)' }}>—</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <div className="text-eyebrow" style={{ marginBottom: 8 }}>Rendered caption — {platform}</div>
            <div
              style={{
                background: 'var(--color-surface-2)', borderRadius: 'var(--radius-md)', padding: '12px 14px',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, lineHeight: 1.6,
                color: 'var(--color-ink)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflowY: 'auto',
              }}
            >
              {preview.rendered[platform] || <span style={{ color: 'var(--color-ink-dim)' }}>(empty)</span>}
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}

function destinationLabel(s: Strategy): React.ReactNode {
  if (s.channel_key) return s.channel_key;
  if (s.meta_account) {
    return s.meta_account.username ? `@${s.meta_account.username}` : s.meta_account.platform;
  }
  if (s.platform === 'tiktok') return 'TikTok';
  return <span style={{ color: 'var(--color-ink-dim)' }}>—</span>;
}

function Term({ children }: { children: React.ReactNode }) {
  return <dt className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>{children}</dt>;
}
function Def({ children }: { children: React.ReactNode }) {
  return <dd className="text-body-sm" style={{ color: 'var(--color-ink)', margin: 0 }}>{children}</dd>;
}

/** Form field wrapper — label eyebrow + optional hint. Copied from EditStrategyModal. */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span className="text-eyebrow">{label}</span>
        {hint && <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** Compact card for additional preview items below the main example. */
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
          style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 'var(--radius-sm)', flexShrink: 0 }}
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        {item.title && (
          <div className="text-body-sm" style={{ color: 'var(--color-ink)', fontWeight: 500 }}>{item.title}</div>
        )}
        {item.text && (
          <p className="text-micro" style={{
            color: 'var(--color-ink-muted)', margin: '4px 0 0',
            display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
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
