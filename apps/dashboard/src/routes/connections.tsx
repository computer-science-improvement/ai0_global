// Telegram connections hub — one place for every Telegram-family connector:
//   Сесії    → MTProto sessions (account info, multi-session-ready)
//   Боти      → publishing bots
//   Telegraph → telegra.ph accounts
// Other platforms (Instagram / TikTok / Facebook) keep their own sidebar
// entries + placeholder pages (/connections/$platform). Active tab mirrored
// in ?tab= for reload/linkability.

import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { SessionsPanel } from '../components/connections/SessionsPanel';
import { BotsManager } from '../components/connections/BotsManager';
import { TelegraphManager } from '../components/connections/TelegraphManager';

type Tab = 'sessions' | 'bots' | 'telegraph';

const TABS: ReadonlyArray<{ key: Tab; label: string }> = [
  { key: 'sessions',  label: 'Сесії' },
  { key: 'bots',      label: 'Боти' },
  { key: 'telegraph', label: 'Telegraph' },
];

const VALID: Tab[] = ['sessions', 'bots', 'telegraph'];

interface Search { tab: Tab; }

export const Route = createFileRoute('/connections')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    tab: VALID.includes(s.tab as Tab) ? (s.tab as Tab) : 'sessions',
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
        title="Підключення · Telegram"
        subtitle="Сесії, боти та Telegraph в одному місці"
      />

      <div style={{ overflowX: 'auto', marginBottom: 20, paddingBottom: 2 }}>
        <SegmentedTabs value={tab} onChange={setTab} options={TABS} />
      </div>

      {tab === 'sessions'  && <SessionsPanel />}
      {tab === 'bots'      && <BotsManager />}
      {tab === 'telegraph' && <TelegraphManager />}
    </div>
  );
}
