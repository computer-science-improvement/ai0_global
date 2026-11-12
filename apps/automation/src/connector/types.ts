import type { McpTool } from '../editor/mcp/mcp-server';

/**
 * Spec 103 — contracts between the connector's parts:
 *   WP-A (OAuth + /api/mcp transport) calls CONNECTOR_TOOLS per request with the caller's grant;
 *   WP-C (the tools) implements it.
 */

export const CONNECTOR_SCOPES = ['mcp:read', 'mcp:write'] as const;
export type ConnectorScope = (typeof CONNECTOR_SCOPES)[number];

/** Plain-English scope labels (consent page, Settings → Connectors). */
export const SCOPE_LABELS: Record<ConnectorScope, string> = {
  'mcp:read':  'See channels, the schedule, posts, logs and problems',
  'mcp:write': 'Plan and prepare posts (locked from agent edits), approve posts, talk to your agents and apply their cards',
};

/** The authenticated caller of one /api/mcp request. */
export interface ConnectorPrincipal {
  grantId:    string;
  clientId:   string;
  clientName: string;
  scopes:     ReadonlySet<ConnectorScope>;
}

/** A connector tool: an MCP tool plus the scope it needs (tools/list shows only the caller's). */
export interface ConnectorTool extends McpTool {
  scope: ConnectorScope;
}

/** WP-C implements it; WP-A calls it for every request. */
export interface ConnectorToolsFactory {
  tools(p: ConnectorPrincipal): Promise<ConnectorTool[]>;
}
export const CONNECTOR_TOOLS = 'CONNECTOR_TOOLS';

/** Public URLs derived from MCP_PUBLIC_URL || DASHBOARD_URL (an https origin, no path). */
export interface ConnectorUrls {
  /** https://dev.ai0.global */
  origin:   string;
  /** The canonical resource = the URL the owner types into Claude: https://dev.ai0.global/api/mcp */
  resource: string;
  /** The OAuth issuer (the bare origin). */
  issuer:   string;
  /**
   * Where the owner signs in and where the consent page lives: the origin of DASHBOARD_URL, else `origin`. It may differ
   * from `origin` when MCP_PUBLIC_URL points at another host; the session cookie and the Telegram widget belong to the dashboard host.
   */
  dashboardOrigin?: string;
  /** Protected Resource Metadata URL: <origin>/.well-known/oauth-protected-resource/api/mcp */
  prm:      string;
}

export const MCP_PATH = '/api/mcp';

/** Status of the connector for Settings → Connectors and every request. */
export interface ConnectorStatus {
  enabled:    boolean;
  configured: boolean;
  url:        string | null;
  issuer:     string | null;
  httpsOk:    boolean;
  /** Origin of the consent / sign-in pages (DASHBOARD_URL, else the connector origin). */
  dashboardOrigin?: string | null;
  /** Why it is not usable: 'off' | 'not_configured' | 'not_https' | null. */
  reason:     'off' | 'not_configured' | 'not_https' | null;
}

/** The origin of DASHBOARD_URL when it is an http(s) URL, else the fallback. */
function dashboardOriginOf(raw: string | undefined, fallback: string): string {
  try {
    const u = new URL((raw ?? '').trim());
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.origin;
  } catch { /* unset or not a URL */ }
  return fallback;
}

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/**
 * Resolve the connector's URLs and on/off state from the environment (settings overlay writes process.env).
 * `MCP_CONNECTOR` = on|off (default off); `MCP_PUBLIC_URL` (empty → `DASHBOARD_URL`). The public URL must be an
 * https origin; http is accepted only for localhost (local development).
 */
export function connectorStatus(env: (k: string) => string | undefined): { status: ConnectorStatus; urls: ConnectorUrls | null } {
  const enabledFlag = (env('MCP_CONNECTOR') ?? 'off').trim().toLowerCase() === 'on';
  const raw = (env('MCP_PUBLIC_URL') || env('DASHBOARD_URL') || '').trim();
  let urls: ConnectorUrls | null = null;
  let httpsOk = false;
  if (raw) {
    try {
      const u = new URL(raw);
      const local = LOCAL_HOST_RE.test(u.hostname);
      httpsOk = u.protocol === 'https:' || (u.protocol === 'http:' && local);
      if (u.protocol === 'https:' || u.protocol === 'http:') {
        const origin = u.origin;
        urls = { origin, issuer: origin, dashboardOrigin: dashboardOriginOf(env('DASHBOARD_URL'), origin), resource: `${origin}${MCP_PATH}`, prm: `${origin}/.well-known/oauth-protected-resource${MCP_PATH}` };
      }
    } catch { /* not a URL: not configured */ }
  }
  const reason: ConnectorStatus['reason'] = !urls ? 'not_configured' : !httpsOk ? 'not_https' : !enabledFlag ? 'off' : null;
  return {
    status: { enabled: reason === null, configured: !!urls, url: urls?.resource ?? null, issuer: urls?.issuer ?? null, httpsOk, dashboardOrigin: urls?.dashboardOrigin ?? null, reason },
    urls: reason === null ? urls : (urls && httpsOk ? urls : null),
  };
}
