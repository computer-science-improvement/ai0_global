// Spec 078 B2: the Inbox (/app/agents/inbox). The page itself is components/inbox/InboxPage.tsx; this route owns the URL
// (?tab=, ?unread=, ?note=, see lib/inbox-view.ts) and the page's stylesheet.

import { createFileRoute } from '@tanstack/react-router';
import { InboxPage } from '../components/inbox/InboxPage';
import { useCrumbs } from '../nav/hooks';
import { parseInboxSearch, type InboxSearch } from '../lib/inbox-view';
import '../components/inbox/inbox.css';

export const Route = createFileRoute('/app/agents_/inbox')({
  // ?tab=approvals — "Posts to approve" (spec 031); the owner's Telegram alert links here.
  validateSearch: (s: Record<string, unknown>): InboxSearch => parseInboxSearch(s),
  component: InboxRoute,
});

function InboxRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const crumbs = useCrumbs('agents-inbox');
  return <InboxPage search={search} crumbs={crumbs} onNavigate={(next) => { void navigate({ search: next, replace: true }); }} />;
}
