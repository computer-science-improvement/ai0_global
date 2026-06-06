// Read-only settings page — mirrors the server .env. Two tabs: Telegram (live
// values via GET /settings) and Meta (placeholder). Active tab in ?tab= for
// reload/linkability, validated like the connections route.

import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '../components/ui/PageHeader';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { Placeholder } from '../components/ui/Placeholder';
import { Badge } from '../components/ui/Badge';
import { settingsApi } from '../api/settings';
import type { AppSettings } from '../api/types';

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
      <PageHeader title="Налаштування" subtitle="Значення з .env — змінюються на сервері + рестарт" />

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

function BoolChip({ value }: { value: boolean }) {
  return value
    ? <Badge tone="success">увімкнено</Badge>
    : <Badge tone="warning">вимкнено</Badge>;
}

function SetChip({ value }: { value: boolean }) {
  return value
    ? <Badge tone="success">задано</Badge>
    : <Badge tone="neutral">не задано</Badge>;
}

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  gap: 12, padding: '10px 0',
  borderBottom: '1px solid var(--color-hairline-soft)',
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={rowStyle}>
      <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>{label}</span>
      <span className="text-body-sm" style={{ color: 'var(--color-ink)' }}>{children}</span>
    </div>
  );
}

function TelegramTab() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['settings'],
    queryFn:  () => settingsApi.get(),
  });

  if (isLoading) return <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Завантаження…</p>;
  if (error)     return <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(error as Error).message}</p>;
  if (!data)     return null;

  const t: AppSettings['telegram'] = data.telegram;
  const ai: AppSettings['ai'] = data.ai;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h2 className="text-heading-md" style={{ margin: '0 0 8px', fontWeight: 500 }}>Відстеження</h2>

        {!t.trackingEnabled && (
          <div className="callout-warning" style={{ marginBottom: 8 }}>
            TRACKING_ENABLED ≠ true — статистика підписників не збирається
          </div>
        )}

        <Row label="trackingEnabled"><BoolChip value={t.trackingEnabled} /></Row>
        <Row label="trackingShareSession"><BoolChip value={t.trackingShareSession} /></Row>
        <Row label="statsPostAgeDays">{t.statsPostAgeDays} днів</Row>
        <Row label="postingCooldownMin">{t.postingCooldownMin} хв</Row>
        <Row label="fetchTimeoutMs">{t.fetchTimeoutMs} мс</Row>
      </section>

      <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h2 className="text-heading-md" style={{ margin: '0 0 8px', fontWeight: 500 }}>AI-ключі</h2>
        <Row label="Anthropic"><SetChip value={ai.anthropic} /></Row>
        <Row label="Perplexity"><SetChip value={ai.perplexity} /></Row>
        <Row label="OpenAI"><SetChip value={ai.openai} /></Row>
        <Row label="Grok"><SetChip value={ai.grok} /></Row>
      </section>
    </div>
  );
}
