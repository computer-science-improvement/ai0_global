import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

// Agent loadout (spec 054): which tools an agent is offered. GET /api/agents/:handle/loadout, PUT …/loadout/tools,
// POST …/loadout/reset. Responses are camelCase; the PUT body is { tools: string[] }.

export type LoadoutMode = 'role' | 'custom';
export type ToolKind = 'read' | 'act' | 'terminal';

export interface LoadoutTool {
  name:        string;
  kind:        ToolKind;
  description: string;
  /** Every agent of the role needs it; cannot be switched off. */
  core:        boolean;
  /** Offered to the agent's runs now. */
  enabled:     boolean;
  /** False when runs of the role always drop the tool (it cannot be switched on). */
  available:   boolean;
  /** Size of the tool's schema, in tokens. */
  tokens:      number;
  calls30d:    number;
  errors30d:   number;
  lastUsedAt:  string | null;
}

export interface LoadoutSkill {
  name:         string;
  scope:        string;
  enabled:      boolean;
  inline:       boolean;
  loads30d:     number;
  lastLoadedAt: string | null;
  chars:        number;
}

export interface LoadoutRules {
  ownerRules:    number;
  memory:        number;
  steeringSets:  number;
  playbookRules: number;
  chars:         number;
}

export interface Loadout {
  mode:    LoadoutMode;
  role:    string;
  tools:   LoadoutTool[];
  skills:  LoadoutSkill[];
  rules:   LoadoutRules;
  tokens:  { current: number; roleDefault: number };
  runs30d: number;
  suggestions: unknown[];
}

const enc = encodeURIComponent;
const key = (handle: string) => ['agents', 'loadout', handle] as const;

export function useLoadout(handle: string) {
  return useQuery({
    queryKey: key(handle),
    queryFn:  () => api<Loadout>(`/api/agents/${enc(handle)}/loadout`),
    // A 404 (an older server) is a plain empty state, not something to retry.
    retry: (n, err) => (err as { status?: number })?.status !== 404 && n < 2,
  });
}

export function usePutLoadoutTools(handle: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tools: string[]) => api<Loadout>(`/api/agents/${enc(handle)}/loadout/tools`, { method: 'PUT', body: JSON.stringify({ tools }) }),
    onSuccess: (r) => { qc.setQueryData(key(handle), r); },
  });
}

export function useResetLoadout(handle: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<Loadout>(`/api/agents/${enc(handle)}/loadout/reset`, { method: 'POST' }),
    onSuccess: (r) => { qc.setQueryData(key(handle), r); },
  });
}
