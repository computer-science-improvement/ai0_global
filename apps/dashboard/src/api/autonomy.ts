import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

// Spec 090 FR-010: the decisions the system made because the owner stayed silent, and their undo —
// GET /api/autonomy/decisions?channel=&since=&limit=, POST /api/autonomy/decisions/:id/undo.

export type DecisionAction = 'applied' | 'dropped' | 'resumed' | 'failed' | 'undone';

export interface AutonomyDecision {
  id:         number;
  /** Registry key, e.g. `directive:frequency`. */
  gate:       string;
  /** The gate family: `directive`, `pending_action`, `playbook`, `audit_fix`, `readiness_fix`, `series_pause`, `setup_proposal`, `launch_graduation`. */
  family:     string;
  refType:    string;
  refId:      string;
  channelKey: string | null;
  action:     DecisionAction;
  /** One English line. */
  summary:    string;
  decidedAt:  string;
  undoneAt:   string | null;
  undoneBy:   string | null;
  canUndo:    boolean;
}

export interface DecisionQuery { channel?: string; since?: string; limit?: number }

export function decisionsPath(q: DecisionQuery = {}): string {
  const p = new URLSearchParams();
  if (q.channel) p.set('channel', q.channel);
  if (q.since) p.set('since', q.since);
  if (q.limit) p.set('limit', String(q.limit));
  const s = p.toString();
  return `/api/autonomy/decisions${s ? `?${s}` : ''}`;
}

export const fetchDecisions = (q: DecisionQuery = {}) => api<{ decisions: AutonomyDecision[] }>(decisionsPath(q));
export const undoDecision = (id: number) => api<{ decision: AutonomyDecision }>(`/api/autonomy/decisions/${id}/undo`, { method: 'POST' });

export function useDecisions(q: DecisionQuery) {
  return useQuery({
    queryKey: ['autonomy-decisions', q.channel ?? null, q.since ?? null, q.limit ?? null],
    queryFn:  () => fetchDecisions(q),
    refetchInterval: 60_000,
  });
}

export function useUndoDecision() {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (id: number) => undoDecision(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['autonomy-decisions'] }),
  });
}
