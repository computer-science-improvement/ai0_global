import { CONNECTOR_SCOPES, type ConnectorScope } from '../types';

/** Lifetimes (spec 103 §4): fixed, not settings. */
export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;
export const CODE_TTL_MS = 5 * 60 * 1000;
export const REQUEST_TTL_MS = 10 * 60 * 1000;
/** A refresh token presented again this soon after rotation is a lost response being retried, not theft. */
export const REFRESH_GRACE_MS = 60 * 1000;

export const DCR_PER_IP_PER_HOUR = 20;
export const DCR_MAX_ACTIVE = 100;
export const CIMD_CACHE_MS = 24 * 3600 * 1000;
export const CIMD_TIMEOUT_MS = 5000;
export const CIMD_MAX_BYTES = 64 * 1024;

export const RATE_LIMIT_PER_MIN = 120;
export const TOUCH_INTERVAL_MS = 60 * 1000;
export const TOOL_TIMEOUT_MS = 200 * 1000;

export const isScope = (s: string): s is ConnectorScope => (CONNECTOR_SCOPES as readonly string[]).includes(s);

/** The only URL clients we accept (spec §2). Everything else is `unauthorized_client`. */
export const CIMD_URL_HOSTED = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
export const CIMD_URL_CODE = 'https://claude.ai/oauth/claude-code-client-metadata';

export interface PinnedClient { name: string; redirectUris: string[] }
/** Used when the metadata document cannot be fetched. */
export const PINNED_CIMD: Record<string, PinnedClient> = {
  [CIMD_URL_HOSTED]: { name: 'Claude', redirectUris: ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'] },
  [CIMD_URL_CODE]:   { name: 'Claude Code', redirectUris: ['http://localhost/callback', 'http://127.0.0.1/callback'] },
};
