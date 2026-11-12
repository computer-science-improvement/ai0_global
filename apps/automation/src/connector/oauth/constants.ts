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
/** A failed metadata fetch is remembered this long, so repeated authorize calls do not each wait on claude.ai. */
export const CIMD_FAIL_CACHE_MS = 5 * 60 * 1000;
export const CIMD_TIMEOUT_MS = 5000;
export const CIMD_MAX_BYTES = 64 * 1024;

/** GET /api/oauth/authorize: per client address, and live (undecided) consent requests per client. */
export const AUTHORIZE_PER_IP_PER_MIN = 60;
export const PENDING_REQUESTS_PER_CLIENT = 50;

export const RATE_LIMIT_PER_MIN = 120;
export const TOUCH_INTERVAL_MS = 60 * 1000;
/** One tool result on the remote endpoint, in characters of compact JSON (Claude Code's own limit is about 25,000 tokens). */
export const MAX_RESULT_CHARS = 80_000;
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
