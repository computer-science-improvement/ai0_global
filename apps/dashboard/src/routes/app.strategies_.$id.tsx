import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '../components/ui/PageHeader';
import { Panel } from '../components/ui/Card';
import { Icon } from '../components/Icon';
import { TelegramPreview } from '../components/post/TelegramPreview';
import { SchedulePicker } from '../components/SchedulePicker';
import { CrosspostSection } from '../components/CrosspostSection';
import { trackingApi } from '../api/tracking';
import { ApiError } from '../api/client';
import { useStrategies, useStrategyPreview, usePatchStrategy } from '../api/strategies';
import {
  STRATEGY_STATUS_HELP, RUN_STATUS_HELP, describeStrategy, SOURCE_KIND_LABEL,
  STRATEGY_DESCRIPTIONS, channelOptionLabel,
} from '../lib/labels';
import { FINITE_POOL_TYPES } from '../lib/runway';
import type { ComposedPostInput, PreviewItem, Strategy } from '../api/types';

export const Route = createFileRoute('/app/strategies_/$id')({ component: StrategyDetailPage });

const LOREM_TEXT =
  '<b>Lorem ipsum dolor sit amet</b>\n\nConsectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation…';

const EXT_ID_RE = /^[A-Za-z0-9_:-]+$/;

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
        <EditPanel strategy={s} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <ConfigPanel strategy={s} meta={meta} />
          <ExamplePostPanel strategyId={s.id} />
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
  );
}

/**
 * Editable form for all mutable fields of a strategy binding — ported from the
 * retired EditStrategyModal, plus the ext_id rename (which used to be an inline
 * table editor). Only telegram bindings expose a channel <select>; meta/tiktok
 * bindings show their destination read-only. Sends only changed fields.
 */
function EditPanel({ strategy }: { strategy: Strategy }) {
  const isTelegram = strategy.platform === 'telegram';

  const [extId,      setExtId]      = useState(strategy.ext_id);
  const [type,       setType]       = useState(strategy.type);
  const [channelId,  setChannelId]  = useState(strategy.channel_id);
  const [schedule,   setSchedule]   = useState(strategy.schedule);
  const [paramsText, setParamsText] = useState(JSON.stringify(strategy.params ?? {}, null, 2));
  const [paramsErr,  setParamsErr]  = useState<string | null>(null);
  const [enabled,    setEnabled]    = useState(strategy.enabled);
  const [notes,      setNotes]      = useState(strategy.notes ?? '');
  // Empty string = "use the default" (sends null on save). Number string = override.
  const [threshold,  setThreshold]  = useState<string>(
    strategy.low_content_threshold == null ? '' : String(strategy.low_content_threshold),
  );
  const [saved, setSaved] = useState(false);

  const showThreshold = FINITE_POOL_TYPES.has(strategy.type);

  // Resync local form state if the underlying strategy changes (background
  // refetch / navigating between strategies on the same route).
  useEffect(() => {
    setExtId(strategy.ext_id);
    setType(strategy.type);
    setChannelId(strategy.channel_id);
    setSchedule(strategy.schedule);
    setParamsText(JSON.stringify(strategy.params ?? {}, null, 2));
    setParamsErr(null);
    setEnabled(strategy.enabled);
    setNotes(strategy.notes ?? '');
    setThreshold(strategy.low_content_threshold == null ? '' : String(strategy.low_content_threshold));
    setSaved(false);
  }, [strategy.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = usePatchStrategy();

  const channels = useQuery({
    queryKey: ['channels', 'mine-picker'],
    queryFn:  () => trackingApi.listChannels({ filter: 'mine', pageSize: 200 }),
    enabled:  isTelegram,
  });

  // Validate JSON live so Save isn't blocked silently.
  const tryParseParams = (): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(paramsText);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setParamsErr('params must be a JSON object');
        return null;
      }
      setParamsErr(null);
      return parsed as Record<string, unknown>;
    } catch (err: any) {
      setParamsErr(err.message);
      return null;
    }
  };

  const trimmedExtId = extId.trim();
  const extIdFormatOk = EXT_ID_RE.test(trimmedExtId);
  const extIdEmpty = trimmedExtId.length === 0;

  const submit = async () => {
    setSaved(false);
    if (extIdEmpty || !extIdFormatOk) return;

    const parsedParams = tryParseParams();
    if (parsedParams === null) return;

    // Only send fields that actually changed — keeps PATCH payload minimal
    // and avoids no-op writes.
    const body: Record<string, unknown> = {};
    if (trimmedExtId !== strategy.ext_id)   body.ext_id     = trimmedExtId;
    if (type      !== strategy.type)        body.type       = type.trim();
    if (isTelegram && channelId !== strategy.channel_id) body.channel_id = channelId;
    if (schedule  !== strategy.schedule)    body.schedule   = schedule.trim();
    if (enabled   !== strategy.enabled)     body.enabled    = enabled;
    if (notes     !== (strategy.notes ?? '')) body.notes    = notes.trim() || null;
    if (JSON.stringify(parsedParams) !== JSON.stringify(strategy.params ?? {})) {
      body.params = parsedParams;
    }
    if (showThreshold) {
      const next = threshold.trim() === '' ? null : Math.max(0, Math.floor(Number(threshold)));
      const current = strategy.low_content_threshold;
      if (next !== current && !(next === null && current == null)) {
        body.low_content_threshold = next;
      }
    }

    if (Object.keys(body).length === 0) { setSaved(true); return; }

    try {
      await patch.mutateAsync({ id: strategy.id, patch: body });
      setSaved(true);
    } catch { /* error rendered inline */ }
  };

  const err = patch.error;
  const conflict = err instanceof ApiError && (err.status === 409 || /already exists/i.test(err.message));
  const errMsg = conflict
    ? `Id "${trimmedExtId}" already exists — pick another.`
    : err ? (err as Error).message : null;

  return (
    <Panel title="Edit strategy">
      <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginBottom: 12 }}>
        Destination is fixed at creation. To change it, delete and recreate the strategy.
      </div>

      <Field label="Name (id)">
        <input
          value={extId}
          onChange={e => { setExtId(e.target.value); setSaved(false); }}
          className="input-field"
          style={{ width: '100%', fontVariantNumeric: 'tabular-nums' }}
        />
        {!extIdFormatOk && trimmedExtId.length > 0 && (
          <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: '6px 0 0' }}>
            Only letters, digits, and _ : - are allowed.
          </p>
        )}
        {extIdEmpty && (
          <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: '6px 0 0' }}>Id cannot be empty.</p>
        )}
      </Field>

      <Field label="Type">
        <input
          value={type}
          onChange={e => { setType(e.target.value); setSaved(false); }}
          list="strategy-type-suggestions"
          className="input-field"
          style={{ width: '100%' }}
        />
        <datalist id="strategy-type-suggestions">
          {Object.keys(STRATEGY_DESCRIPTIONS).map(k => <option key={k} value={k} />)}
        </datalist>
        <TypeDescription type={type} />
      </Field>

      <Field label="Channel">
        {isTelegram ? (
          <select
            value={channelId}
            onChange={e => { setChannelId(e.target.value); setSaved(false); }}
            className="input-field"
            style={{ width: '100%' }}
          >
            {channels.data?.items.map(c => (
              <option key={c.id} value={c.id}>{channelOptionLabel(c)}</option>
            ))}
          </select>
        ) : (
          <div>
            <div className="text-body-sm" style={{ color: 'var(--color-ink)' }}>{destinationLabel(strategy)}</div>
            <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: '6px 0 0' }}>
              Destination is fixed at creation.
            </p>
          </div>
        )}
      </Field>

      <Field label="Schedule (cron)">
        <SchedulePicker value={schedule} onChange={v => { setSchedule(v); setSaved(false); }} />
      </Field>

      <Field label="Params (JSON)" hint="full replacement on save">
        <textarea
          value={paramsText}
          onChange={e => { setParamsText(e.target.value); setParamsErr(null); setSaved(false); }}
          onBlur={tryParseParams}
          className="input-field"
          style={{
            width: '100%', minHeight: 160,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 12, lineHeight: 1.5, letterSpacing: 0,
          }}
        />
        {paramsErr && (
          <p className="text-micro" style={{ color: 'var(--color-danger)', marginTop: 6 }}>{paramsErr}</p>
        )}
      </Field>

      <Field label="Notes (optional)">
        <input
          value={notes}
          onChange={e => { setNotes(e.target.value); setSaved(false); }}
          placeholder="Why does this exist?"
          className="input-field"
          style={{ width: '100%' }}
        />
      </Field>

      {showThreshold && (
        <Field label="Low-content alert (posts)">
          <input
            type="number"
            min={0}
            value={threshold}
            onChange={e => { setThreshold(e.target.value); setSaved(false); }}
            placeholder="100 (default)"
            className="input-field"
            style={{ width: 160 }}
            title="Warn when the remaining content for this strategy drops below this many posts. Leave empty to use the default (100)."
          />
        </Field>
      )}

      <Field label="Status">
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={e => { setEnabled(e.target.checked); setSaved(false); }}
            style={{ accentColor: 'var(--color-accent)' }}
          />
          <span className="text-body-sm" style={{ color: 'var(--color-ink)' }}>
            Enabled — cron fires this strategy
          </span>
        </label>
      </Field>

      <CrosspostSection channelId={channelId} />

      <div className="callout-warning" style={{ marginBottom: 16 }}>
        <Icon name="info" size={14} />
        <span className="text-micro">
          Schedule + channel changes take effect immediately (hot-reload via config:changed). Param changes pick up on the next tick.
        </span>
      </div>

      {errMsg && (
        <p className="text-body-sm" style={{ color: 'var(--color-danger)', marginBottom: 12 }}>{errMsg}</p>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12 }}>
        {saved && !patch.isPending && (
          <span className="text-micro" style={{ color: 'var(--color-success, var(--color-accent))' }}>
            <Icon name="check" size={12} style={{ marginRight: 4 }} />Saved
          </span>
        )}
        <button
          onClick={submit}
          disabled={patch.isPending || extIdEmpty || !extIdFormatOk}
          className="btn-primary"
        >
          {patch.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
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

/** Live description of the entered strategy type. Copied from EditStrategyModal. */
function TypeDescription({ type }: { type: string }) {
  const meta = describeStrategy(type.trim());
  if (!meta) return null;
  return (
    <div
      style={{
        marginTop: 8,
        padding: '10px 12px',
        background: 'var(--color-surface-1)',
        borderRadius: 'var(--radius-md)',
        borderLeft: '2px solid var(--color-accent)',
      }}
    >
      <div className="text-body-sm" style={{ color: 'var(--color-ink)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="sparkle" size={12} />
        {meta.title}
        <span className="chip" style={{ fontSize: 10 }}>{SOURCE_KIND_LABEL[meta.source]}</span>
      </div>
      <p className="text-micro" style={{ color: 'var(--color-ink-muted)', margin: '6px 0 0', lineHeight: 1.5 }}>
        {meta.description}
      </p>
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
