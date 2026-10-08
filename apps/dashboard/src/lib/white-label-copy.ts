// Spec 026 FR-012/FR-013: the honest white-label promise, shared by the #white-label
// section on / and the /white-label page so both say exactly the same thing.
// Owner decisions: English only; white label is a separate deployment per client
// today (single-tenant), operated by the owner, plus consultation. No self-hosted
// licence, no public pricing, no shared client cabinet.

export const SINGLE_TENANT_STATEMENT =
  'Today ai0 is single-tenant. White label means a separate deployment for your resources, with its own database, keys, bot and accounts, which we set up and run for you. There is no shared cabinet for several clients yet.';

export const WHITE_LABEL_PITCH =
  'The same AI agents that run the ai0 network, set up for your own channels and profiles.';

/** FR-013: what a shared, multi-client platform would still need (listed, not built). */
export const SHARED_PLATFORM_NEEDS: string[] = [
  'Real accounts and roles for every client instead of one owner login.',
  'A tenant id and row-level security on every table, so no client can see another’s data.',
  'Per-client secrets, encryption keys, AI budgets and API keys.',
  'A MANAGER agent and cross-promotion scoped to one client, so different clients’ networks are never mixed.',
  'Per-client Telegram, bot and platform accounts, isolated from each other’s rate limits.',
  'Queue prefixes and distributed locks, so more than one server can run at once.',
  'Billing, data export and deletion, and an audit log.',
];

export interface FaqItem { q: string; a: string }

export const WHITE_LABEL_FAQ: FaqItem[] = [
  {
    q: 'Who owns the data and the accounts?',
    a: 'You do. Your deployment has its own database, and your channels, bot and platform accounts stay yours. Nothing is shared with the ai0 network or with other clients.',
  },
  {
    q: 'Do the agents pretend to be people?',
    a: 'No. AI agents plan, write and publish the posts. Replies to direct messages are drafted by an AI assistant on your behalf, you check them before they are sent, and your public pages say so openly.',
  },
  {
    q: 'What is the shadow period?',
    a: 'Every new agent starts in shadow mode: it plans and writes, but your existing setup keeps publishing. You compare the two, and switch a channel to the agent only when you are happy with its work.',
  },
  {
    q: 'Which platforms are supported today?',
    a: 'Telegram channels, Instagram, Facebook pages, Threads and TikTok. YouTube support is in progress. Tell us what you run, and we will say honestly what works now.',
  },
  {
    q: 'What does it cost?',
    a: 'It depends on the number of resources and how much the agents write. We will send a quote after a short call; there is no public price list.',
  },
];
