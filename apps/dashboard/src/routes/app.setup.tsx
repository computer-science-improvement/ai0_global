// Legacy /app/setup (spec 042 page): setups from history are artifacts now (spec 048 FR-008). Redirect-only;
// ?proposal=<id> opens that proposal. A new setup starts in the chat with /setup @channel.

import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/app/setup')({
  validateSearch: (s: Record<string, unknown>): { proposal?: string } => ({
    proposal: typeof s.proposal === 'string' && s.proposal ? s.proposal : undefined,
  }),
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/app/artifacts', search: { type: 'setup', ...(search.proposal ? { open: `setup:${search.proposal}` } : {}) }, replace: true });
  },
});
