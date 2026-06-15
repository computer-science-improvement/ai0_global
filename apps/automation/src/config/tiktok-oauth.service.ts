// Builds the TikTok authorize URL (with a signed state) and verifies returned
// states. The code→token exchange itself lives in TikTokTokenService (5a).
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { signState, verifyState } from './tiktok-oauth-state.util';

const AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const DEFAULT_SCOPES = 'user.info.basic,video.publish';

@Injectable()
export class TikTokOAuthService {
  constructor(private readonly env: ConfigService) {}

  private secret(): string {
    return this.env.get<string>('JWT_SECRET') ?? '';
  }

  /** TikTok authorize URL with a fresh signed state. Throws if unconfigured. */
  buildAuthorizeUrl(nowMs: number): string {
    const clientKey = this.env.get<string>('TIKTOK_CLIENT_KEY');
    const redirect  = this.env.get<string>('TIKTOK_REDIRECT_URI');
    if (!clientKey || !redirect) throw new Error('TikTok OAuth not configured (client key / redirect URI)');
    const scope = this.env.get<string>('TIKTOK_SCOPES') ?? DEFAULT_SCOPES;
    const params = new URLSearchParams({
      client_key:    clientKey,
      scope,
      response_type: 'code',
      redirect_uri:  redirect,
      state:         signState(this.secret(), nowMs),
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  /** Verify a returned state token. */
  verifyState(token: string, nowMs: number): boolean {
    return verifyState(this.secret(), token, nowMs);
  }
}
