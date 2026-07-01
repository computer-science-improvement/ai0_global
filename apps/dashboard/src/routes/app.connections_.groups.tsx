// Dedicated Meta groups page — link a brand's Facebook + Instagram + Threads
// accounts so a recipe-carousel / ai0-prompts strategy publishing to the group's
// Facebook account fans the same post out to its IG + Threads siblings. Its own
// route + sidebar entry (not a tab inside the Connections workspace).

import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { MetaGroupsManager } from '../components/connections/MetaGroupsManager';

export const Route = createFileRoute('/app/connections_/groups')({ component: MetaGroupsPage });

function MetaGroupsPage() {
  return (
    <div>
      <PageHeader
        title="Groups"
        subtitle="Link a brand's Telegram channel + Facebook, Instagram and Threads accounts"
      />
      <MetaGroupsManager />
    </div>
  );
}
