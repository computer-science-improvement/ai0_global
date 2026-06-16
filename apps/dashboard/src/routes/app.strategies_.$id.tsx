import { createFileRoute, Link } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { Panel } from '../components/ui/Card';
import { Icon } from '../components/Icon';
import { TelegramPreview } from '../components/post/TelegramPreview';
import { useStrategies, useStrategyPreview } from '../api/strategies';
import {
  STRATEGY_STATUS_HELP, RUN_STATUS_HELP, describeStrategy, SOURCE_KIND_LABEL,
} from '../lib/labels';
import type { ComposedPostInput, PreviewItem, Strategy } from '../api/types';

export const Route = createFileRoute('/app/strategies_/$id')({ component: StrategyDetailPage });

const LOREM_TEXT =
  '<b>Lorem ipsum dolor sit amet</b>\n\nConsectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation…';

function StrategyDetailPage() {
  const { id } = Route.useParams();
  const { data: strategies, isLoading, error } = useStrategies();
  const s = (strategies ?? []).find(x => x.id === id);

  return (
    <div>
      <Link to={'/app/strategies' as never} className="link-accent text-body-sm" style={{ display: 'inline-block', marginBottom: 16 }}>
        ← Back to strategies
      </Link>

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

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
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
                ? <span className="chip chip-success" title={STRATEGY_STATUS_HELP.enabled}>
                    <Icon name="check" size={12} style={{ marginRight: 4 }} />enabled
                  </span>
                : <span className="chip" title={STRATEGY_STATUS_HELP.paused}>paused</span>}
            </Def>

            <Term>Last run</Term>
            <Def>
              {s.last_run ? (
                <span
                  className={
                    s.last_run.status === 'ok'      ? 'chip chip-success' :
                    s.last_run.status === 'error'   ? 'chip chip-danger'  :
                    s.last_run.status === 'skipped' ? 'chip chip-warning' :
                    'chip'
                  }
                  title={(RUN_STATUS_HELP[s.last_run.status] ?? s.last_run.status) + (s.last_run.error ? `\n\n${s.last_run.error}` : '')}
                >
                  {s.last_run.status}
                </span>
              ) : <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>never</span>}
            </Def>
          </dl>
        </Panel>

        <ExamplePostPanel strategyId={s.id} />
      </div>
    </div>
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
