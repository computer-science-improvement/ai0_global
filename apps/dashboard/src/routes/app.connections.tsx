// Unified Connections workspace — every connector managed in one place.
//
// Two tab dimensions live in the URL for reload/linkability:
//   ?section=telegram|meta|tiktok   — the provider (top-level pills)
//   ?tab=…                          — the sub-tab within Telegram/Meta
//   ?tiktok=connected|error         — OAuth-callback banner for the TikTok tab
//
// Architecturally each connector still has its own DB table + repository; this
// page only composes the existing manager components (SessionsPanel, BotsManager,
// TelegraphManager, MetaAccountsManager, TikTokAccountsManager) under one route.
// The old /connections/meta and /connections/tiktok routes redirect here, so
// deep links and the TikTok OAuth callback keep working.

import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { SessionsPanel } from '../components/connections/SessionsPanel';
import { BotsManager } from '../components/connections/BotsManager';
import { TelegraphManager } from '../components/connections/TelegraphManager';
import { MetaAccountsManager } from '../components/connections/MetaAccountsManager';
import { TikTokAccountsManager } from '../components/connections/TikTokAccountsManager';
import { useMtprotoSessions } from '../api/mtproto-sessions';
import { useBots } from '../api/bots';
import { useTelegraphAccounts } from '../api/telegraph';
import { useMetaAccounts } from '../api/meta-accounts';
import { useTikTokAccounts } from '../api/tiktok-accounts';
import { connectionCounts } from '../lib/connection-counts';

type Section = 'telegram' | 'meta' | 'tiktok';

const SECTIONS: ReadonlyArray<{ key: Section; label: string }> = [
  { key: 'telegram', label: 'Telegram' },
  { key: 'meta',     label: 'Meta' },
  { key: 'tiktok',   label: 'TikTok' },
];

type TelegramTab = 'sessions' | 'bots' | 'telegraph';
const TELEGRAM_TABS: ReadonlyArray<{ key: TelegramTab; label: string }> = [
  { key: 'sessions',  label: 'Sessions' },
  { key: 'bots',      label: 'Bots' },
  { key: 'telegraph', label: 'Telegraph' },
];

type MetaTab = 'facebook' | 'instagram' | 'threads';
const META_TABS: ReadonlyArray<{ key: MetaTab; label: string }> = [
  { key: 'facebook',  label: 'Facebook' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'threads',   label: 'Threads' },
];

const SECTION_VALID: Section[] = ['telegram', 'meta', 'tiktok'];

interface Search {
  section: Section;
  tab?:    string;
  tiktok?: 'connected' | 'error';
}

export const Route = createFileRoute('/app/connections')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    section: SECTION_VALID.includes(s.section as Section) ? (s.section as Section) : 'telegram',
    tab:     typeof s.tab === 'string' ? s.tab : undefined,
    tiktok:  s.tiktok === 'connected' || s.tiktok === 'error' ? s.tiktok : undefined,
  }),
  component: ConnectionsPage,
});

const SUBTITLE: Record<Section, string> = {
  telegram: 'Sessions, bots and Telegraph in one place',
  meta:     'Facebook, Instagram and Threads accounts',
  tiktok:   'Connect a TikTok creator account for carousels',
};

function ConnectionsPage() {
  const { section, tab, tiktok } = Route.useSearch();
  const navigate = Route.useNavigate();

  // Switching provider resets the sub-tab to that provider's default.
  const setSection = (s: Section) => navigate({ search: { section: s } });
  const setTab = (t: string) => navigate({ search: (prev) => ({ ...prev, tab: t }) });

  // Resolve the effective sub-tab per section, defaulting when absent/foreign.
  const tgTab: TelegramTab = TELEGRAM_TABS.some((o) => o.key === tab) ? (tab as TelegramTab) : 'sessions';
  const metaTab: MetaTab   = META_TABS.some((o) => o.key === tab) ? (tab as MetaTab) : 'facebook';

  // The numbers on the tabs come from the lists the managers load anyway (same query keys, so no extra requests).
  const sessions = useMtprotoSessions();
  const bots = useBots();
  const telegraph = useTelegraphAccounts();
  const meta = useMetaAccounts();
  const tiktokAccounts = useTikTokAccounts();
  const counts = connectionCounts({ sessions: sessions.data, bots: bots.data, telegraph: telegraph.data, meta: meta.data, tiktok: tiktokAccounts.data });
  const total = counts.telegram != null && counts.meta != null && counts.tiktok != null ? counts.telegram + counts.meta + counts.tiktok : null;
  const eyebrow = total == null ? undefined
    : `${total} ${total === 1 ? 'connection' : 'connections'}${counts.problems ? ` · ${counts.problems} with errors` : ''}`;

  return (
    <div>
      <PageHeader eyebrow={eyebrow} title="Connections" subtitle={SUBTITLE[section]} />

      <div style={{ marginBottom: 18 }}>
        <SegmentedTabs
          value={section} onChange={setSection} ariaLabel="Provider"
          options={SECTIONS.map((o) => ({ ...o, count: counts[o.key] }))}
        />
      </div>

      {section === 'telegram' && (
        <div>
          <div style={{ marginBottom: 20 }}>
            <SegmentedTabs
              value={tgTab} onChange={setTab} variant="underline" ariaLabel="Telegram connections"
              options={TELEGRAM_TABS.map((o) => ({ ...o, count: counts[o.key] }))}
            />
          </div>
          {tgTab === 'sessions'  && <SessionsPanel />}
          {tgTab === 'bots'      && <BotsManager />}
          {tgTab === 'telegraph' && <TelegraphManager />}
        </div>
      )}

      {section === 'meta' && (
        <div>
          <div style={{ marginBottom: 20 }}>
            <SegmentedTabs
              value={metaTab} onChange={setTab} variant="underline" ariaLabel="Meta platforms"
              options={META_TABS.map((o) => ({ ...o, count: counts[o.key] }))}
            />
          </div>
          <MetaAccountsManager platform={metaTab} />
        </div>
      )}

      {section === 'tiktok' && <TikTokAccountsManager notice={tiktok} />}
    </div>
  );
}
