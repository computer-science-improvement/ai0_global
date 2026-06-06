// Settings page. Two tabs: Telegram (live values via GET /settings; the
// "Відстеження" block is editable and persisted via PATCH /settings) and Meta
// (placeholder). Active tab in ?tab= for reload/linkability.

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

type Tab = 'telegram' | 'meta';

const TABS: ReadonlyArray<{ key: Tab; label: string }> = [
  { key: 'telegram', label: 'Telegram' },
  { key: 'meta',     label: 'Meta' },
];

const VALID: Tab[] = ['telegram', 'meta'];

interface Search { tab: Tab; }

export const Route = createFileRoute('/settings')({
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
      <PageHeader title="Налаштування" subtitle="Значення з .env · зміни зберігаються в БД і перевизначають .env" />

      <div style={{ overflowX: 'auto', marginBottom: 20, paddingBottom: 2 }}>
        <SegmentedTabs value={tab} onChange={setTab} options={TABS} />
      </div>

      {tab === 'telegram' && <TelegramTab />}
      {tab === 'meta'     && (
        <Placeholder
          icon="facebook"
          title="Meta — скоро"
          note="Інтеграція Facebook / Instagram / Threads зʼявиться згодом."
        />
      )}
    </div>
  );
}

function SetChip({ value }: { value: boolean }) {
  return value
    ? <Badge tone="success">задано</Badge>
    : <Badge tone="neutral">не задано</Badge>;
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

function NumberField({ value, onChange, min, max, suffix }: {
  value: number; onChange: (v: number) => void; min: number; max: number; suffix: string;
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <input
        type="number"
        className="input-field"
        value={Number.isFinite(value) ? value : ''}
        min={min} max={max}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        style={{ width: 110, textAlign: 'right', padding: '6px 10px', fontSize: 14 }}
      />
      <span className="text-caption" style={{ color: 'var(--color-ink-dim)', minWidth: 36 }}>{suffix}</span>
    </span>
  );
}

function FieldLabel({ name, note, overridden }: { name: string; note?: string; overridden?: boolean }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>{name}</span>
        {overridden && <Badge tone="neutral">перевизначено</Badge>}
      </span>
      {note && <span className="text-caption" style={{ color: 'var(--color-ink-dim)' }}>{note}</span>}
    </span>
  );
}

// Maps a draft field → the env key the server reports in `overrides`.
const FIELD_KEY: Record<keyof SettingsPatch, string> = {
  trackingEnabled:      'TRACKING_ENABLED',
  trackingShareSession: 'TELEGRAM_TRACKING_SHARE_SESSION',
  statsPostAgeDays:     'STATS_POST_AGE_DAYS',
  postingCooldownMin:   'POSTING_COOLDOWN_MIN',
  fetchTimeoutMs:       'FETCH_TIMEOUT',
};

type Draft = AppSettings['telegram'];

function TelegramTab() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data, isLoading, error } = useQuery({
    queryKey: ['settings'],
    queryFn:  () => settingsApi.get(),
  });

  const [draft, setDraft] = useState<Draft | null>(null);
  // Sync the editable draft whenever fresh server data arrives.
  useEffect(() => { if (data) setDraft(data.telegram); }, [data]);

  const save = useMutation({
    mutationFn: (patch: SettingsPatch) => settingsApi.update(patch),
    onSuccess: (fresh) => { qc.setQueryData(['settings'], fresh); setDraft(fresh.telegram); },
  });

  if (isLoading) return <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Завантаження…</p>;
  if (error)     return <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(error as Error).message}</p>;
  if (!data || !draft) return null;

  const ai: AppSettings['ai'] = data.ai;
  const overrides = new Set(data.overrides);
  const ov = (f: keyof SettingsPatch) => overrides.has(FIELD_KEY[f]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v });

  // Build a patch of only changed fields. NaN number inputs are dropped.
  const dirtyPatch = (): SettingsPatch => {
    const p: SettingsPatch = {};
    const base = data.telegram;
    if (draft.trackingEnabled      !== base.trackingEnabled)      p.trackingEnabled = draft.trackingEnabled;
    if (draft.trackingShareSession !== base.trackingShareSession) p.trackingShareSession = draft.trackingShareSession;
    if (draft.statsPostAgeDays     !== base.statsPostAgeDays   && Number.isFinite(draft.statsPostAgeDays))   p.statsPostAgeDays = draft.statsPostAgeDays;
    if (draft.postingCooldownMin   !== base.postingCooldownMin && Number.isFinite(draft.postingCooldownMin)) p.postingCooldownMin = draft.postingCooldownMin;
    if (draft.fetchTimeoutMs       !== base.fetchTimeoutMs     && Number.isFinite(draft.fetchTimeoutMs))     p.fetchTimeoutMs = draft.fetchTimeoutMs;
    return p;
  };
  const patch = dirtyPatch();
  const dirty = Object.keys(patch).length > 0;

  const onSave = async () => {
    const labels = Object.keys(patch).join(', ');
    if (await confirm(`зберегти зміни налаштувань (${labels})`, { danger: false, confirmLabel: 'Зберегти' })) {
      save.mutate(patch);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <h2 className="text-heading-md" style={{ margin: 0, fontWeight: 500 }}>Відстеження</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {dirty && <span className="text-caption" style={{ color: 'var(--color-ink-dim)' }}>незбережені зміни</span>}
            <Button variant="primary" disabled={!dirty || save.isPending} onClick={onSave}>
              {save.isPending ? 'Збереження…' : 'Зберегти'}
            </Button>
          </div>
        </div>

        {save.error && (
          <div className="callout-warning" style={{ marginBottom: 8 }}>
            Не вдалося зберегти: {(save.error as Error).message}
          </div>
        )}
        {!draft.trackingEnabled && (
          <div className="callout-warning" style={{ marginBottom: 8 }}>
            TRACKING_ENABLED ≠ true — статистика підписників не збирається
          </div>
        )}

        <div style={rowStyle}>
          <FieldLabel name="trackingEnabled" overridden={ov('trackingEnabled')} />
          <Toggle checked={draft.trackingEnabled} onChange={(v) => set('trackingEnabled', v)} />
        </div>
        <div style={rowStyle}>
          <FieldLabel name="trackingShareSession" note="застосується після рестарту" overridden={ov('trackingShareSession')} />
          <Toggle checked={draft.trackingShareSession} onChange={(v) => set('trackingShareSession', v)} />
        </div>
        <div style={rowStyle}>
          <FieldLabel name="statsPostAgeDays" overridden={ov('statsPostAgeDays')} />
          <NumberField value={draft.statsPostAgeDays} onChange={(v) => set('statsPostAgeDays', v)} min={1} max={365} suffix="днів" />
        </div>
        <div style={rowStyle}>
          <FieldLabel name="postingCooldownMin" overridden={ov('postingCooldownMin')} />
          <NumberField value={draft.postingCooldownMin} onChange={(v) => set('postingCooldownMin', v)} min={1} max={1440} suffix="хв" />
        </div>
        <div style={{ ...rowStyle, borderBottom: 'none' }}>
          <FieldLabel name="fetchTimeoutMs" note="лише для pipeline · після рестарту" overridden={ov('fetchTimeoutMs')} />
          <NumberField value={draft.fetchTimeoutMs} onChange={(v) => set('fetchTimeoutMs', v)} min={1000} max={120000} suffix="мс" />
        </div>
      </section>

      <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h2 className="text-heading-md" style={{ margin: '0 0 8px', fontWeight: 500 }}>AI-ключі</h2>
        <div style={rowStyle}><span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Anthropic</span><SetChip value={ai.anthropic} /></div>
        <div style={rowStyle}><span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Perplexity</span><SetChip value={ai.perplexity} /></div>
        <div style={rowStyle}><span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>OpenAI</span><SetChip value={ai.openai} /></div>
        <div style={{ ...rowStyle, borderBottom: 'none' }}><span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Grok</span><SetChip value={ai.grok} /></div>
      </section>
    </div>
  );
}
