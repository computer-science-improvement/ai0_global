import { api } from './client';

// Spec 103: the Claude connector (a remote MCP server with its own OAuth). Settings → Connectors reads and edits it
// through /api/connector/*; the consent page uses /api/oauth/requests/*. Both need the owner's dashboard session.

export interface ConnectorStatus {
  enabled:    boolean;
  configured: boolean;
  /** The URL to paste into Claude (public origin + /api/mcp); empty when not configured. */
  url:        string;
  issuer:     string;
  httpsOk:    boolean;
  /** Why it is off or not usable (a short code or sentence), when it is not. */
  reason?:    string | null;
}

export interface ConnectorClient {
  id:             string;
  clientId:       string;
  kind:           string;
  name:           string;
  redirectHosts:  string[];
  createdAt:      string;
  lastUsedAt:     string | null;
  activeGrants:   number;
}

export interface ConnectorGrant {
  id:         string;
  clientId:   string;
  clientName: string;
  scopes:     string[];
  createdAt:  string;
  lastUsedAt: string | null;
  lastIp:     string | null;
  expiresAt:  string | null;
}

export interface ConnectorActivity {
  id:         string | number;
  at:         string;
  /** `tools/call` or an OAuth event (register, consent_allow, consent_deny, token_issued, refresh_reuse, revoked). */
  event:      string;
  tool:       string | null;
  clientName: string | null;
  /** `null` on OAuth rows (register, consent, token, revoke): only tool calls carry a success flag. */
  ok:         boolean | null;
  error:      string | null;
  durationMs: number | null;
  summary:    string | null;
}

export interface ConsentRequest {
  id:        string;
  client:    { clientId: string; name: string; kind: string; redirectHost: string; loopback: boolean };
  scopes:    Array<{ scope: string; label: string }>;
  expiresAt: string;
}

const enc = encodeURIComponent;

export const connectorsApi = {
  status:       () => api<ConnectorStatus>('/api/connector/status'),
  clients:      () => api<{ clients: ConnectorClient[] }>('/api/connector/clients').then((r) => r.clients),
  grants:       () => api<{ grants: ConnectorGrant[] }>('/api/connector/grants').then((r) => r.grants),
  activity:     (limit = 50) => api<{ items: ConnectorActivity[] }>(`/api/connector/activity?limit=${limit}`).then((r) => r.items),
  revokeClient: (id: string) => api<{ ok: boolean; revoked: number }>(`/api/connector/clients/${enc(id)}`, { method: 'DELETE' }),
  revokeGrant:  (id: string) => api<{ ok: boolean }>(`/api/connector/grants/${enc(id)}`, { method: 'DELETE' }),
  revokeAll:    () => api<{ ok: boolean; revoked: number }>('/api/connector/grants/revoke-all', { method: 'POST' }),
  request:      (id: string) => api<ConsentRequest>(`/api/oauth/requests/${enc(id)}`),
  decide:       (id: string, decision: 'allow' | 'deny', scopes?: string[]) =>
    api<{ redirect: string }>(`/api/oauth/requests/${enc(id)}/decision`, { method: 'POST', body: JSON.stringify({ decision, ...(scopes ? { scopes } : {}) }) }),
};

export const CONNECTOR_STATUS_KEY = ['connector', 'status'] as const;
export const CONNECTOR_CLIENTS_KEY = ['connector', 'clients'] as const;
export const CONNECTOR_GRANTS_KEY = ['connector', 'grants'] as const;
export const CONNECTOR_ACTIVITY_KEY = ['connector', 'activity'] as const;
