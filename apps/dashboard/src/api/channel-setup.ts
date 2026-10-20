import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

// Channel setup from history (spec 042): the onboarder reads an own channel's
// last 20 posts and proposes its agent's setup in six sections, applied one by
// one. GET /api/channel-setup/overview, POST /analyze {channelKeys},
// GET /proposals?channel=, GET /proposals/:id, POST /proposals/:id/apply {sections},
// POST /proposals/:id/discard. Section bodies are the onboarder's snake_case JSON.

export const SETUP_SECTIONS = ['brief_profile', 'formatting', 'format_mix', 'series_pillars', 'schedule', 'examples_voice'] as const;
export type SetupSection = typeof SETUP_SECTIONS[number];
export type SectionState = 'pending' | 'applied' | 'skipped';
export const OPEN_SETUP_STATUSES = ['queued', 'collecting', 'analyzing', 'ready'] as const;
export type SetupStatus =
  | typeof OPEN_SETUP_STATUSES[number]
  | 'applied' | 'partially_applied' | 'discarded' | 'superseded' | 'failed' | 'no_access' | 'too_few_posts';

export interface SetupProposalBrief {
  id:            string;
  channelKey:    string;
  resourceRef:   string;
  agentId:       string | null;
  status:        SetupStatus;
  reason:        string | null;
  retryAt:       string | null;
  postIds:       string[];
  sectionStatus: Partial<Record<SetupSection, SectionState>>;
  runId:         string | null;
  costUsd:       number;
  createdBy:     string;
  createdAt:     string;
  updatedAt:     string;
  appliedAt:     string | null;
}

export interface Evidence { post_ids: string[]; note: string }

export interface SetupSections {
  summary: string;
  brief_profile: {
    profile: {
      topic?: string; audience?: { who?: string; age?: string; geo?: string; interests?: string[] } | null; language?: string;
      goals?: string[]; tone?: string; taboo?: string[]; notes?: string;
    };
    brief: string;
    evidence: Evidence;
  };
  formatting: {
    format_prefs: Record<string, unknown>;
    style?: Record<string, unknown>;
    card: { hashtags?: string[]; hashtag_min?: number; hashtag_max?: number; footer?: string | null; emoji_policy?: string; link_style?: string };
    evidence: Evidence;
  };
  format_mix: { formats: Record<string, number>; evidence: Evidence };
  series_pillars: {
    series: Array<{ name: string; cadence: string; format: string; brief: string; post_ids: string[] }>;
    pillars: Array<{ name: string; share: number }>;
    evidence: Evidence;
  };
  schedule: {
    posts_per_day_min: number; posts_per_day_max: number; quiet_start_hour: number; quiet_end_hour: number; best_hours: number[];
    evidence: Evidence;
  };
  examples_voice: {
    example_ids: string[];
    voice: { description: string; rules: string[]; quotes: string[] };
    evidence: Evidence;
  };
}

export interface ChannelMetrics {
  posts:       number;
  timezone:    string;
  spanDays:    number;
  activeDays:  number;
  perDay:      number;
  hours:       number[];
  peakHours:   number[];
  quiet:       { start: number; end: number } | null;
  formatMix:   Record<string, number>;
  length:      { median: number; p90: number };
  lineBreaks:  number;
  emoji:       { share: number; median: number };
  hashtags:    { share: number; vocabulary: string[] };
  links:       number;
  mentions:    number;
  cta:         number;
  signature:   string | null;
  address:     { ty: number; vy: number };
  topPosts:    string[];
  rubrics:     Array<{ label: string; posts: string[] }>;
  medianViews: number | null;
}

export interface SetupProposal extends SetupProposalBrief {
  metrics:  ChannelMetrics | null;
  sections: SetupSections | null;
  baseline: Record<SetupSection, unknown> | null;
}

export interface SetupPostRef {
  key:       string;
  id:        string;
  msgId:     number;
  postedAt:  string;
  firstLine: string;
  views:     number | null;
  hasMedia:  boolean;
  mediaType: string | null;
  link:      string;
}

export interface SetupProposalView {
  proposal: SetupProposal;
  posts:    SetupPostRef[];
  /** What each section holds now; null once the proposal is closed. */
  current:  Record<SetupSection, unknown> | null;
  /** Pending sections changed since the analysis (Apply refuses them). */
  drift:    SetupSection[];
  /** Owner-locked formatting fields the Apply keeps. */
  kept:     string[];
}

export interface SetupOverviewRow {
  channelKey:     string;
  title:          string | null;
  trackingStatus: string;
  postsStored:    number;
  hasCard:        boolean;
  mode:           string | null;
  hasBrief:       boolean;
  hasProfile:     boolean;
  hasPlaybook:    boolean;
  agentHandle:    string | null;
  latest:         { id: string; status: SetupStatus; reason: string | null; createdAt: string; costUsd: number } | null;
}

export interface SetupOverview { channels: SetupOverviewRow[]; estimateUsd: number | null }

export interface ApplyResult {
  proposal:             SetupProposal | null;
  applied:              SetupSection[];
  kept:                 string[];
  rebuilt:              boolean;
  failed:               { section: SetupSection; error: string } | null;
  changedSinceAnalysis: SetupSection[];
}

const isOpen = (s: SetupStatus | undefined) => !!s && (s === 'queued' || s === 'collecting' || s === 'analyzing');

export function useSetupOverview() {
  return useQuery({
    queryKey: ['channel-setup', 'overview'],
    queryFn:  () => api<SetupOverview>('/api/channel-setup/overview'),
    // Rows poll while a run is queued or analysing.
    refetchInterval: (q) => (q.state.data?.channels.some((c) => isOpen(c.latest?.status)) ? 4_000 : false),
  });
}

export function useChannelProposals(channel: string | null | undefined) {
  return useQuery({
    queryKey: ['channel-setup', 'proposals', channel],
    queryFn:  () => api<{ proposals: SetupProposalBrief[] }>(`/api/channel-setup/proposals?channel=${encodeURIComponent(channel!)}`),
    enabled:  !!channel,
    refetchInterval: (q) => (isOpen(q.state.data?.proposals[0]?.status) ? 4_000 : false),
  });
}

export function useSetupProposal(id: string | null | undefined) {
  return useQuery({
    queryKey: ['channel-setup', 'proposal', id],
    queryFn:  () => api<SetupProposalView>(`/api/channel-setup/proposals/${encodeURIComponent(id!)}`),
    enabled:  !!id,
    refetchInterval: (q) => (isOpen(q.state.data?.proposal.status) ? 4_000 : false),
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['channel-setup'] });
    void qc.invalidateQueries({ queryKey: ['artifacts'] });
    // Apply changes the agent, its playbook and skills.
    void qc.invalidateQueries({ queryKey: ['agents'] });
    void qc.invalidateQueries({ queryKey: ['network'] });
  };
}

export function useAnalyzeChannels() {
  const done = useInvalidate();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (channelKeys: string[]) =>
      api<{ queued: SetupProposalBrief[]; refused: Array<{ channelKey: string; error: string }> }>(
        '/api/channel-setup/analyze', { method: 'POST', body: JSON.stringify({ channelKeys }) }),
    onSuccess: done,
  });
}

export function useApplySetup() {
  const done = useInvalidate();
  return useMutation({
    meta: { silentError: true },
    // `override`: sections applied although they changed since the analysis (the proposal replaces the newer change).
    mutationFn: ({ id, sections, override }: { id: string; sections: SetupSection[]; override?: SetupSection[] }) =>
      api<ApplyResult>(`/api/channel-setup/proposals/${encodeURIComponent(id)}/apply`, {
        method: 'POST', body: JSON.stringify(override?.length ? { sections, override } : { sections }),
      }),
    onSuccess: done,
  });
}

export function useDiscardSetup() {
  const done = useInvalidate();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (id: string) => api<{ proposal: SetupProposal }>(`/api/channel-setup/proposals/${encodeURIComponent(id)}/discard`, { method: 'POST' }),
    onSuccess: done,
  });
}
