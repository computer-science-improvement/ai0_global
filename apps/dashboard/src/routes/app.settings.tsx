// Settings page. Three tabs: Configuration (spec 039: every setting that moved out of .env, built from the server's
// catalog; ?group= filters it), Security (dashboard sessions + sign-in audit, spec 028) and Navigation (the menu
// constructor, spec 027: ?edit=<item id> focuses an item, ?from=<href> is the page "Add current page" captures).
// Active tab in ?tab= for reload/linkability; the old telegram / ai / meta tabs open Configuration.

import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { SecurityTab } from '../components/settings/SecurityTab';
import { NavigationTab } from '../components/settings/NavigationTab';
import { ConfigurationTab } from '../components/settings/ConfigurationTab';
import '../components/settings/settings.css';

type Tab = 'configuration' | 'security' | 'navigation';

const TABS: ReadonlyArray<{ key: Tab; label: string }> = [
  { key: 'configuration', label: 'Configuration' },
  { key: 'security',      label: 'Security' },
  { key: 'navigation',    label: 'Navigation' },
];

const VALID: Tab[] = ['configuration', 'security', 'navigation'];
/** Links to the tabs that became Configuration groups keep working. */
const LEGACY: Record<string, { tab: Tab; group: string }> = {
  telegram: { tab: 'configuration', group: 'telegram' },
  ai:       { tab: 'configuration', group: 'ai' },
  meta:     { tab: 'configuration', group: 'publishing' },
};

interface Search { tab: Tab; group?: string; edit?: string; from?: string; }

export const Route = createFileRoute('/app/settings')({
  validateSearch: (s: Record<string, unknown>): Search => {
    const legacy = typeof s.tab === 'string' ? LEGACY[s.tab] : undefined;
    const tab = legacy?.tab ?? (VALID.includes(s.tab as Tab) ? (s.tab as Tab) : 'configuration');
    const group = typeof s.group === 'string' && /^[a-z]{2,20}$/.test(s.group) ? s.group : legacy?.group;
    return {
      tab,
      ...(group ? { group } : {}),
      ...(typeof s.edit === 'string' && /^[a-z0-9_:-]{1,64}$/.test(s.edit) ? { edit: s.edit } : {}),
      ...(typeof s.from === 'string' && s.from.startsWith('/app') && s.from.length <= 500 ? { from: s.from } : {}),
    };
  },
  component: SettingsPage,
});

function SettingsPage() {
  const { tab, group, edit, from } = Route.useSearch();
  const navigate = Route.useNavigate();
  const setTab = (t: Tab) => navigate({ search: { tab: t } });
  const setGroup = (g: string) => navigate({ search: { tab: 'configuration', ...(g === 'all' ? {} : { group: g }) }, replace: true });

  return (
    <div>
      <PageHeader title="Settings" subtitle="Everything but infrastructure: values imported from .env once, then edited here" />

      <div className="set-tabs">
        <SegmentedTabs variant="underline" value={tab} onChange={setTab} options={TABS} ariaLabel="Settings sections" />
      </div>

      {tab === 'configuration' && <ConfigurationTab group={group ?? 'all'} onGroup={setGroup} />}
      {tab === 'security' && <SecurityTab />}
      {tab === 'navigation' && <NavigationTab editId={edit} from={from} />}
    </div>
  );
}
