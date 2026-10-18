import { useQuery } from '@tanstack/react-query';
import { api } from './client';
import type { SourceHealth } from './agents';
import type { BudgetState } from './spend';

// Spec 049 FR-005: GET /api/network-health — connections, sources, budget headroom and stuck work in one view.

export type BadConnectionState = 'no_access' | 'token_invalid' | 'token_expiring' | 'rate_limited';

export interface ConnectionIssue {
  ref: string; title: string | null; state: BadConnectionState; detail: string | null;
  since: string | null; checkedAt: string | null; expiresAt: string | null; muted: boolean; agent: string | null;
}

export interface SourceIssue extends SourceHealth { channelKey: string; agent: string | null }

export interface BudgetLine { label: string; spentUsd: number; capUsd: number; pct: number; state: BudgetState; enforce: boolean }

export type StuckKind = 'slot_running' | 'slot_overdue' | 'slot_failed' | 'approval_waiting' | 'action_waiting' | 'playbook_waiting' | 'ideas_waiting';

export interface StuckItem { id: string; title: string; at: string; channelKey?: string | null; agent?: string | null; detail?: string | null }

export interface StuckGroup { kind: StuckKind; label: string; rule: string; count: number; oldestAt: string | null; items: StuckItem[] }

export interface NetworkHealth {
  generatedAt: string;
  connections: ConnectionIssue[];
  sources:     SourceIssue[];
  budget:      { lines: BudgetLine[]; blocking: Array<{ kind: string; id: string; label: string; spentUsd: number; capUsd: number }>; slotsHit: number };
  stuck:       StuckGroup[];
  problems:    number;
}

export function useNetworkHealth() {
  return useQuery({
    queryKey: ['network-health'],
    queryFn:  () => api<NetworkHealth>('/api/network-health'),
    refetchInterval: 60_000,
  });
}
