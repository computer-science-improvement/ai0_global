// Legacy /app/steering (spec 045 page): steering sets are artifacts now (spec 048 FR-008). Redirect-only;
// ?set=<id> opens that set. New steering starts in the chat with /steer @yours @theirs.

import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/app/steering')({
  validateSearch: (s: Record<string, unknown>): { set?: string } => ({
    set: typeof s.set === 'string' && s.set ? s.set : undefined,
  }),
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/app/artifacts', search: { type: 'steering', ...(search.set ? { open: `steering:${search.set}` } : {}) }, replace: true });
  },
});
