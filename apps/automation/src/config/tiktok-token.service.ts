// TikTok OAuth token service: exchange auth codes and refresh rotating tokens
// against /v2/oauth/token/. The `post` seam is overridable in tests so no live
// network is hit. Tokens and the client secret are never logged.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { TikTokAccountsRepository, TikTokAccountRow } from './tiktok-accounts.repository';
import { toTokenSet } from './tiktok-token.util';

const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const SKEW_MS = 60_000; // refresh this long before the real expiry

@Injectable()
export class TikTokTokenService {
  private readonly logger = new Logger(TikTokTokenService.name);

  constructor(
    private readonly env:  ConfigService,
    private readonly repo: TikTokAccountsRepository,
  ) {}

  private creds(): { key: string; secret: string; redirect?: string } {
    const key = this.env.get<string>('TIKTOK_CLIENT_KEY');
    const secret = this.env.get<string>('TIKTOK_CLIENT_SECRET');
    if (!key || !secret) throw new Error('TikTok client credentials not configured');
    return { key, secret, redirect: this.env.get<string>('TIKTOK_REDIRECT_URI') };
  }

  /** HTTP seam — overridable in tests. Returns the parsed JSON body. */
  protected async post(url: string, form: Record<string, string>): Promise<any> {
    const res = await axios.post(url, new URLSearchParams(form), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15_000,
    });
    return res.data;
  }

  /** Exchange an authorization code for tokens and upsert the account. */
  async exchangeCode(code: string): Promise<ReturnType<TikTokAccountsRepository['upsertFromTokens']>> {
    const { key, secret, redirect } = this.creds();
    if (!redirect) throw new Error('TIKTOK_REDIRECT_URI not configured');
    const res = await this.post(TOKEN_URL, {
      client_key: key, client_secret: secret,
      grant_type: 'authorization_code', code, redirect_uri: redirect,
    });
    if (res?.error) throw new Error(`TikTok token exchange failed: ${res.error_description ?? res.error}`);
    const tokens = toTokenSet(res, Date.now());
    return this.repo.upsertFromTokens({ ...tokens, openId: res.open_id, scope: res.scope ?? null });
  }

  /** A valid access token for the account, refreshing first if near expiry. */
  async getValidAccessToken(accountId: string): Promise<string> {
    const acct = await this.repo.findById(accountId);
    if (!acct) throw new Error(`TikTok account ${accountId} not found`);
    if (!acct.active) throw new Error(`TikTok account ${accountId} is inactive`);
    if (acct.access_token_expires_at.getTime() <= Date.now() + SKEW_MS) {
      return this.refresh(acct);
    }
    return acct.access_token;
  }

  /** Force-refresh one account's tokens. */
  async refresh(acct: TikTokAccountRow): Promise<string> {
    const { key, secret } = this.creds();
    try {
      const res = await this.post(TOKEN_URL, {
        client_key: key, client_secret: secret,
        grant_type: 'refresh_token', refresh_token: acct.refresh_token,
      });
      if (res?.error) throw new Error(res.error_description ?? res.error);
      const tokens = toTokenSet(res, Date.now());
      await this.repo.updateTokens(acct.id, tokens);
      return tokens.accessToken;
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      await this.repo.setRefreshError(acct.id, msg);
      if (acct.refresh_token_expires_at.getTime() <= Date.now()) {
        await this.repo.setActive(acct.id, false);
      }
      throw new Error(`TikTok token refresh failed (${acct.id}): ${msg}`);
    }
  }
}
