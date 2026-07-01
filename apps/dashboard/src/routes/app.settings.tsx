// Settings page. Three tabs: Telegram (live values via GET /settings; the
// "Tracking" block is editable and persisted via PATCH /settings), AI (provider
// keys as read-only set/not-set badges) and Meta (placeholder). Active tab in
// ?tab= for reload/linkability.
//
// Editing model: every change (toggle flip or number apply) opens a confirm
// dialog that shows the old → new value before persisting. No batch save.

import { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '../components/ui/PageHeader';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { Placeholder } from '../components/ui/Placeholder';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { settingsApi } from '../api/settings';
import type { AppSettings, SettingsPatch } from '../api/types';

type Tab = 'telegram' | 'ai' | 'meta';

const TABS: ReadonlyArray<{ key: Tab; label: string }> = [
  { key: 'telegram', label: 'Telegram' },
  { key: 'ai',       label: 'AI' },
  { key: 'meta',     label: 'Meta' },
];

const VALID: Tab[] = ['telegram', 'ai', 'meta'];

interface Search { tab: Tab; }

export const Route = createFileRoute('/app/settings')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    tab: VALID.includes(s.tab as Tab) ? (s.tab as Tab) : 'telegram',
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  const setTab = (t: Tab) => navigate({ search: { tab: t } });

  return (
    <div>
      <PageHeader title="Settings" subtitle="Values from .env · changes are saved in the DB and override .env" />

      <div style={{ overflowX: 'auto', marginBottom: 20, paddingBottom: 2 }}>
        <SegmentedTabs value={tab} onChange={setTab} options={TABS} />
      </div>

      {tab === 'telegram' && <TelegramTab />}
      {tab === 'ai'       && <AiTab />}
      {tab === 'meta'     && (
        <Placeholder
          icon="facebook"
          title="Meta — coming soon"
          note="Facebook / Instagram / Threads integration will be added later."
        />
      )}
    </div>
  );
}

function SetChip({ value }: { value: boolean }) {
  return value
    ? <Badge tone="success">set</Badge>
    : <Badge tone="neutral">not set</Badge>;
}

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  gap: 12, padding: '12px 0',
  borderBottom: '1px solid var(--color-hairline-soft)',
};

/** Small Supabase-dark toggle switch. */
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={{
        width: 40, height: 22, borderRadius: 999, padding: 2, flexShrink: 0,
        border: '1px solid var(--color-hairline-strong)',
        background: checked ? 'var(--color-accent)' : 'var(--color-surface-3)',
        cursor: 'pointer', transition: 'background 0.15s ease',
        display: 'flex', justifyContent: checked ? 'flex-end' : 'flex-start',
      }}
    >
      <span style={{ width: 16, height: 16, borderRadius: 999, background: '#fff', transition: 'all 0.15s ease' }} />
    </button>
  );
}

function FieldLabel({ name, note, overridden }: { name: string; note?: string; overridden?: boolean }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <code className="text-body-sm" style={{ color: 'var(--color-ink)', fontFamily: 'var(--font-mono, monospace)', letterSpacing: '-0.01em' }}>{name}</code>
        {overridden && <Badge tone="neutral">overridden</Badge>}
      </span>
      {note && <span className="text-caption" style={{ color: 'var(--color-ink-dim)' }}>{note}</span>}
    </span>
  );
}

/** Renders the old → new value diff shown inside the confirm dialog. */
function DiffPreview({ envKey, oldText, newText }: { envKey: string; oldText: string; newText: string }) {
  const pill = (tone: 'old' | 'new'): React.CSSProperties => ({
    padding: '3px 10px', borderRadius: 'var(--radius-sm)', fontSize: 13,
    fontFamily: 'var(--font-mono, monospace)',
    background: tone === 'old' ? 'var(--color-surface-3)' : 'var(--color-success-soft)',
    color: tone === 'old' ? 'var(--color-ink-muted)' : 'var(--color-accent)',
    border: `1px solid ${tone === 'old' ? 'var(--color-hairline)' : 'rgba(62,207,142,0.3)'}`,
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <code className="text-caption" style={{ color: 'var(--color-ink-dim)' }}>{envKey}</code>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={pill('old')}>{oldText}</span>
        <span style={{ color: 'var(--color-ink-dim)' }}>→</span>
        <span style={pill('new')}>{newText}</span>
      </div>
    </div>
  );
}

// Maps a draft field → the env key (also the displayed label).
const FIELD_KEY: Record<keyof SettingsPatch, string> = {
  trackingEnabled:      'TRACKING_ENABLED',
  telegramOwnerId:      'TELEGRAM_OWNER_ID',
  trackingShareSession: 'TELEGRAM_TRACKING_SHARE_SESSION',
  statsPostAgeDays:     'STATS_POST_AGE_DAYS',
  postingCooldownMin:   'POSTING_COOLDOWN_MIN',
  fetchTimeoutMs:       'FETCH_TIMEOUT',
};

const AI_KEY_LABEL: Record<keyof AppSettings['ai'], string> = {
  anthropic:  'ANTHROPIC_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
  openai:     'OPENAI_API_KEY',
  grok:       'GROK_API_KEY',
};

function TelegramTab() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data, isLoading, error } = useQuery({
    queryKey: ['settings'],
    queryFn:  () => settingsApi.get(),
  });

  const save = useMutation({
    mutationFn: (patch: SettingsPatch) => settingsApi.update(patch),
    onSuccess: (fresh) => { qc.setQueryData(['settings'], fresh); },
  });

  if (isLoading) return <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>;
  if (error)     return <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(error as Error).message}</p>;
  if (!data) return null;

  const t  = data.telegram;
  const overrides = new Set(data.overrides);

  // Confirm an old → new change, then persist a single-field patch.
  const commit = async (
    field: keyof SettingsPatch,
    oldText: string,
    newText: string,
    value: boolean | number | string,
  ) => {
    const ok = await confirm(`change ${FIELD_KEY[field]}`, {
      danger: false,
      confirmLabel: 'Save',
      details: <DiffPreview envKey={FIELD_KEY[field]} oldText={oldText} newText={newText} />,
    });
    if (ok) save.mutate({ [field]: value } as SettingsPatch);
  };

  const boolText = (v: boolean) => (v ? 'Enabled' : 'Disabled');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <h2 className="text-heading-md" style={{ margin: '0 0 8px', fontWeight: 500 }}>Tracking</h2>

        {save.error && (
          <div className="callout-warning" style={{ marginBottom: 8 }}>
            Failed to save: {(save.error as Error).message}
          </div>
        )}
        {!t.trackingEnabled && (
          <div className="callout-warning" style={{ marginBottom: 8 }}>
            TRACKING_ENABLED ≠ true — subscriber statistics are not being collected
          </div>
        )}

        <div style={rowStyle}>
          <FieldLabel name="TRACKING_ENABLED" overridden={overrides.has('TRACKING_ENABLED')} />
          <Toggle checked={t.trackingEnabled} onChange={(v) => commit('trackingEnabled', boolText(t.trackingEnabled), boolText(v), v)} />
        </div>
        <div style={rowStyle}>
          <FieldLabel name="TELEGRAM_OWNER_ID" note="admin notifications recipient" overridden={overrides.has('TELEGRAM_OWNER_ID')} />
          <EditableText
            serverValue={t.ownerId}
            placeholder="chat id"
            validate={(v) => /^\d*$/.test(v.trim())}
            onCommit={(v) => commit('telegramOwnerId', t.ownerId || '—', v || '—', v)}
          />
        </div>
        <div style={rowStyle}>
          <FieldLabel name="TELEGRAM_TRACKING_SHARE_SESSION" note="applies after restart" overridden={overrides.has('TELEGRAM_TRACKING_SHARE_SESSION')} />
          <Toggle checked={t.trackingShareSession} onChange={(v) => commit('trackingShareSession', boolText(t.trackingShareSession), boolText(v), v)} />
        </div>
        <div style={rowStyle}>
          <FieldLabel name="STATS_POST_AGE_DAYS" overridden={overrides.has('STATS_POST_AGE_DAYS')} />
          <EditableNumber serverValue={t.statsPostAgeDays} min={1} max={365} suffix="days"
            onCommit={(v) => commit('statsPostAgeDays', `${t.statsPostAgeDays} days`, `${v} days`, v)} />
        </div>
        <div style={rowStyle}>
          <FieldLabel name="POSTING_COOLDOWN_MIN" overridden={overrides.has('POSTING_COOLDOWN_MIN')} />
          <EditableNumber serverValue={t.postingCooldownMin} min={1} max={1440} suffix="min"
            onCommit={(v) => commit('postingCooldownMin', `${t.postingCooldownMin} min`, `${v} min`, v)} />
        </div>
        <div style={{ ...rowStyle, borderBottom: 'none' }}>
          <FieldLabel name="FETCH_TIMEOUT" note="pipeline only · after restart" overridden={overrides.has('FETCH_TIMEOUT')} />
          <EditableNumber serverValue={t.fetchTimeoutMs} min={1000} max={120000} suffix="ms"
            onCommit={(v) => commit('fetchTimeoutMs', `${t.fetchTimeoutMs} ms`, `${v} ms`, v)} />
        </div>
      </section>
    </div>
  );
}

/** AI provider keys — read-only "set / not set" badges (the key values are
 *  never returned by the API). Lives in its own tab. */
function AiTab() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['settings'],
    queryFn:  () => settingsApi.get(),
  });

  if (isLoading) return <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>;
  if (error)     return <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(error as Error).message}</p>;
  if (!data) return null;

  const ai = data.ai;

  return (
    <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <h2 className="text-heading-md" style={{ margin: '0 0 8px', fontWeight: 500 }}>AI keys</h2>
      {(Object.keys(AI_KEY_LABEL) as Array<keyof AppSettings['ai']>).map((k, i, arr) => (
        <div key={k} style={i === arr.length - 1 ? { ...rowStyle, borderBottom: 'none' } : rowStyle}>
          <code className="text-body-sm" style={{ color: 'var(--color-ink)', fontFamily: 'var(--font-mono, monospace)' }}>{AI_KEY_LABEL[k]}</code>
          <SetChip value={ai[k]} />
        </div>
      ))}
    </section>
  );
}

/** Number input with an explicit Apply / revert affordance shown only when the
 *  value differs from the server value. Apply triggers the confirm dialog. */
function EditableNumber({ serverValue, min, max, suffix, onCommit }: {
  serverValue: number; min: number; max: number; suffix: string; onCommit: (v: number) => void;
}) {
  const [v, setV] = useState<number>(serverValue);
  useEffect(() => { setV(serverValue); }, [serverValue]);
  const valid = Number.isFinite(v) && v >= min && v <= max;
  const dirty = valid && v !== serverValue;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <input
        type="number"
        className="input-field"
        value={Number.isFinite(v) ? v : ''}
        min={min} max={max}
        onChange={(e) => setV(parseInt(e.target.value, 10))}
        style={{ width: 104, textAlign: 'right', padding: '6px 10px', fontSize: 14 }}
      />
      <span className="text-caption" style={{ color: 'var(--color-ink-dim)', minWidth: 34 }}>{suffix}</span>
      {dirty && (
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <Button variant="primary" onClick={() => onCommit(v)}>Save</Button>
          <Button variant="tiny" onClick={() => setV(serverValue)}>Cancel</Button>
        </span>
      )}
    </span>
  );
}

/** Text input with the same Apply / revert affordance as EditableNumber, used
 *  for free-text env settings (e.g. the owner chat id). An empty value clears
 *  the override. */
function EditableText({ serverValue, placeholder, validate, onCommit }: {
  serverValue: string; placeholder?: string; validate?: (v: string) => boolean; onCommit: (v: string) => void;
}) {
  const [v, setV] = useState<string>(serverValue);
  useEffect(() => { setV(serverValue); }, [serverValue]);
  const valid = validate ? validate(v) : true;
  const dirty = valid && v.trim() !== serverValue.trim();

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <input
        type="text"
        className="input-field"
        value={v}
        placeholder={placeholder}
        onChange={(e) => setV(e.target.value)}
        style={{ width: 160, textAlign: 'right', padding: '6px 10px', fontSize: 14, fontVariantNumeric: 'tabular-nums' }}
      />
      {dirty && (
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <Button variant="primary" onClick={() => onCommit(v.trim())}>Save</Button>
          <Button variant="tiny" onClick={() => setV(serverValue)}>Cancel</Button>
        </span>
      )}
    </span>
  );
}
