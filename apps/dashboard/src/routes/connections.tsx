// Unified Connections hub — one place to control every connector. Tabs:
//   Telegram  → MTProto session status + bots
//   Telegraph → telegra.ph accounts
//   Instagram / TikTok / Facebook → roadmap placeholders
// The active tab is mirrored in ?tab= so it survives reload and is linkable.

import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { Placeholder } from '../components/ui/Placeholder';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { SessionCard } from '../components/connections/SessionCard';
import { BotsManager } from '../components/connections/BotsManager';
import { TelegraphManager } from '../components/connections/TelegraphManager';

type Tab = 'telegram' | 'telegraph' | 'instagram' | 'tiktok' | 'facebook';

const TABS: ReadonlyArray<{ key: Tab; label: string }> = [
  { key: 'telegram',  label: 'Telegram' },
  { key: 'telegraph', label: 'Telegraph' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'tiktok',    label: 'TikTok' },
  { key: 'facebook',  label: 'Facebook' },
];

const VALID: Tab[] = ['telegram', 'telegraph', 'instagram', 'tiktok', 'facebook'];

interface Search { tab: Tab; }

export const Route = createFileRoute('/connections')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    tab: VALID.includes(s.tab as Tab) ? (s.tab as Tab) : 'telegram',
  }),
  component: ConnectionsPage,
});

function ConnectionsPage() {
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  const setTab = (t: Tab) => navigate({ search: { tab: t } });

  return (
    <div>
      <PageHeader
        title="Підключення"
        subtitle="Усі конектори в одному місці — Telegram, Telegraph та майбутні платформи"
      />

      <div style={{ overflowX: 'auto', marginBottom: 20, paddingBottom: 2 }}>
        <SegmentedTabs value={tab} onChange={setTab} options={TABS} />
      </div>

      {tab === 'telegram' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <SessionCard />
          <BotsManager />
        </div>
      )}

      {tab === 'telegraph' && <TelegraphManager />}

      {tab === 'instagram' && (
        <Placeholder icon="instagram" title="Instagram скоро" note="Підключення акаунтів Instagram зʼявиться, коли додамо інтеграцію." />
      )}
      {tab === 'tiktok' && (
        <Placeholder icon="tiktok" title="TikTok скоро" note="Підключення акаунтів TikTok зʼявиться, коли додамо інтеграцію." />
      )}
      {tab === 'facebook' && (
        <Placeholder icon="facebook" title="Facebook скоро" note="Підключення акаунтів Facebook зʼявиться, коли додамо інтеграцію." />
      )}
    </div>
  );
}
