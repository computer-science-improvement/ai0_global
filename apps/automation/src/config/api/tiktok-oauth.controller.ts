import { Controller, Get, Query, Redirect, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { TikTokOAuthService } from '../tiktok-oauth.service';
import { TikTokTokenService } from '../tiktok-token.service';

// Method-level guards: `start` is dashboard-authed; `callback` is public (the
// browser arrives via TikTok redirect with no session — trust comes from the
// signed `state` we issued at `start`).
@Controller('api/tiktok/oauth')
export class TikTokOAuthController {
  constructor(
    private readonly oauth:  TikTokOAuthService,
    private readonly tokens: TikTokTokenService,
    private readonly env:    ConfigService,
  ) {}

  @Get('start')
  @UseGuards(TrackingAuthGuard)
  start(): { url: string } {
    return { url: this.oauth.buildAuthorizeUrl(Date.now()) };
  }

  @Get('callback')
  @Redirect()
  async callback(
    @Query('code')  code?:  string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ): Promise<{ url: string }> {
    const base = `${this.env.get<string>('DASHBOARD_URL') ?? ''}/connections/tiktok`;
    if (error || !code || !state || !this.oauth.verifyState(state, Date.now())) {
      return { url: `${base}?tiktok=error` };
    }
    try {
      await this.tokens.exchangeCode(code);
      return { url: `${base}?tiktok=connected` };
    } catch {
      return { url: `${base}?tiktok=error` };
    }
  }
}
