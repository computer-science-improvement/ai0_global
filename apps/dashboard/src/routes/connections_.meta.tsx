// Meta connections hub — Facebook / Instagram / Threads in one place. Lives at
// /connections/meta but is a ROOT-level route (filename `connections_.meta`),
// so it does NOT inherit the /connections layout's ?tab= search schema. The
// static /meta path wins over the generic /connections/$platform placeholder.
// All tabs are placeholders until the integration lands. Active tab mirrored in
// ?tab= for reload/linkability.

import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { Placeholder } from '../components/ui/Placeholder';

type Tab = 'facebook' | 'instagram' | 'threads';

const TABS: ReadonlyArray<{ key: Tab; label: string }> = [
  { key: 'facebook',  label: 'Facebook' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'threads',   label: 'Threads' },
];

const VALID: Tab[] = ['facebook', 'instagram', 'threads'];

interface Search { tab: Tab; }

export const Route = createFileRoute('/connections_/meta')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    tab: VALID.includes(s.tab as Tab) ? (s.tab as Tab) : 'facebook',
  }),
  component: MetaConnectionsPage,
});

function MetaConnectionsPage() {
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  const setTab = (t: Tab) => navigate({ search: { tab: t } });

  return (
    <div>
      <PageHeader title="Підключення · Meta" subtitle="Facebook, Instagram та Threads в одному місці" />

      <div style={{ overflowX: 'auto', marginBottom: 20, paddingBottom: 2 }}>
        <SegmentedTabs value={tab} onChange={setTab} options={TABS} />
      </div>

      {tab === 'facebook' && (
        <Placeholder icon="facebook" title="Facebook скоро" note="Підключення сторінок Facebook зʼявиться, коли додамо інтеграцію." />
      )}
      {tab === 'instagram' && (
        <Placeholder icon="instagram" title="Instagram скоро" note="Підключення акаунтів Instagram зʼявиться, коли додамо інтеграцію." />
      )}
      {tab === 'threads' && (
        <Placeholder icon="threads" title="Threads скоро" note="Підключення Threads зʼявиться, коли додамо інтеграцію." />
      )}
    </div>
  );
}
