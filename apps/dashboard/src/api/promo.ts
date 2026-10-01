import { useQuery } from '@tanstack/react-query';
import { api } from './client';
import type { EditorSlotStatus } from './types';
import type { DirectiveOutcome } from './manager';

// Spec 022: cross-promo and reposts inside the owner's network. The server
// resolves a role child's handle to its orchestrator; promo JSON is snake_case.

export type PromoKind = 'cross_promo' | 'repost';

export interface PromoPair {
  sourceRef:   string;
  targetRef:   string;
  lastPromoAt: string | null;
  count30d:    number;
  /** Deterministic profile relevance, 0–5 (≥3 to promote). */
  relevance:   number | null;
}

export interface PromoSlot {
  id:      string;
  at:      string;
  status:  EditorSlotStatus;
  error:   string | null;
  promo:   {
    kind:         PromoKind;
    source_ref:   string;
    target_ref:   string;
    link_url?:    string | null;
    tracked?:     boolean;
    relevance?:   number;
    directive_id?: string | null;
    post_ref?:    string | null;
  };
  preview: string | null;
  outcome: DirectiveOutcome | null;
}

export interface TrackedLink {
  id:        string;
  kind:      'tg_invite' | 'utm';
  targetRef: string;
  sourceRef: string;
  url:       string;
  status:    'active' | 'revoked' | string;
  createdAt: string;
  joins:     number;
}

export interface PromoOverview { pairs: PromoPair[]; slots: PromoSlot[]; links: TrackedLink[] }

export function usePromo(handle: string) {
  return useQuery({
    queryKey: ['promo', handle],
    queryFn:  () => api<PromoOverview>(`/api/agents/${encodeURIComponent(handle)}/promo`),
    retry:    false,
    refetchInterval: 60_000,
  });
}
