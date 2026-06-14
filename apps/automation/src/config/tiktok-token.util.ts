// Pure helpers for TikTok OAuth token shaping. No I/O — `nowMs` is passed in so
// these are deterministic and unit-testable.

export interface TikTokTokenSet {
  accessToken:           string;
  refreshToken:          string;
  accessTokenExpiresAt:  Date;
  refreshTokenExpiresAt: Date;
}

/** Raw fields from TikTok's /v2/oauth/token/ response that we consume. */
export interface TikTokTokenResponse {
  access_token:        string;
  refresh_token:       string;
  expires_in:          number;  // access-token lifetime, seconds
  refresh_expires_in:  number;  // refresh-token lifetime, seconds
  open_id?:            string;
  scope?:              string;
}

/** Absolute expiry = base epoch (ms) + lifetime (seconds). */
export function expiryFrom(nowMs: number, seconds: number): Date {
  return new Date(nowMs + seconds * 1000);
}

/** Shape a token response into a TikTokTokenSet with absolute expiries. */
export function toTokenSet(res: TikTokTokenResponse, nowMs: number): TikTokTokenSet {
  return {
    accessToken:           res.access_token,
    refreshToken:          res.refresh_token,
    accessTokenExpiresAt:  expiryFrom(nowMs, res.expires_in),
    refreshTokenExpiresAt: expiryFrom(nowMs, res.refresh_expires_in),
  };
}
