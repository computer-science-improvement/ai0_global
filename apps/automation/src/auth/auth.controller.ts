import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res,
  ServiceUnavailableException, UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService, ClientInfo, retryAfterOf } from './auth.service';
import { TelegramLoginDto } from './telegram-login.dto';
import { TokenLoginDto } from './token-login.dto';
import { RevokeAllDto } from './revoke-all.dto';
import { AUTH_REASON_HEADER, clearSessionCookie, setSessionCookie } from './auth-cookie';
import { clientIp, userAgentOf } from './client-info';
import { AuthContext, JwtPayload } from './auth.types';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';

function clientOf(req: Request): ClientInfo {
  return { ip: clientIp(req), userAgent: userAgentOf(req) };
}

function authOf(req: Request): AuthContext | undefined {
  return (req as any).auth;
}

/**
 * Dashboard auth (spec 028): login (opens a revocable session), `/auth/me`,
 * the nginx `/auth/check`, logout, and the session/audit endpoints behind
 * Settings → Security.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // Both login routes share one limiter (AuthService.login → LoginLimiter):
  // 10 attempts / minute / IP across the pair, lockout after 20 failures / hour.

  @Post('telegram-login')
  async login(@Body() dto: TelegramLoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.runLogin(res, () => this.auth.login('telegram', dto, clientOf(req)));
  }

  /** Shared-token login — paste the TRACKING_TOKEN secret to get a session
   *  cookie. For HTTP/no-DNS boxes where the Telegram widget can't run. */
  @Post('token-login')
  async tokenLogin(@Body() dto: TokenLoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const method = dto.via === 'link' ? 'link' : 'token';
    return this.runLogin(res, () => this.auth.login(method, dto.token.trim(), clientOf(req)));
  }

  private async runLogin(res: Response, login: () => ReturnType<AuthService['login']>) {
    try {
      const { token, identity } = await login();
      this.setCookie(res, token);
      return this.identityBody(identity);
    } catch (err) {
      const retry = retryAfterOf(err);
      if (retry !== null) res.setHeader('Retry-After', String(retry));
      throw err;
    }
  }

  /**
   * The current identity, or `null` without a session (compatible with the old
   * shape). Accepts Bearer like every guarded route; the dev identity comes back
   * only when the backend bypass applies. A dead cookie is cleared and its
   * reason sent in `X-Auth-Reason`.
   */
  @Get('me')
  async me(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const r = await this.auth.authenticate(req);
    if (r.ok) {
      if (r.renewToken) this.setCookie(res, r.renewToken);
      return {
        ...this.identityBody(r.identity),
        method: r.method,
        ...(r.sid ? { sessionId: r.sid } : {}),
        ...(r.expiresAt ? { expiresAt: r.expiresAt.toISOString() } : {}),
      };
    }
    if (r.code === 'unavailable') {
      throw new ServiceUnavailableException({ statusCode: 503, code: 'auth_unavailable', message: 'Sign-in check is temporarily unavailable' });
    }
    if (r.code.startsWith('session_')) {
      res.setHeader(AUTH_REASON_HEADER, r.code);
      clearSessionCookie(res, this.auth.production);
      await this.auth.auditDeadCookie(r.code, 'sid' in r ? r.sid : undefined, clientOf(req));
    }
    return null;
  }

  /**
   * nginx `auth_request` target (FR-004): 204 / 401 with an empty body. No
   * writes, no cookie re-issue, no rate limit; the DB is read only on a cache
   * miss. A DB error is 204 while the JWT is unexpired, else 503 — never 401,
   * so an outage does not log anyone out.
   */
  @Get('check')
  async check(@Req() req: Request, @Res() res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    const r = await this.auth.authenticate(req, { readOnly: true });
    if (r.ok) { res.status(204).end(); return; }
    if (r.code === 'unavailable') { res.status(503).end(); return; }
    res.setHeader(AUTH_REASON_HEADER, r.code);
    res.status(401).end();
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req, clientOf(req));
    clearSessionCookie(res, this.auth.production);
    return { ok: true };
  }

  // ─── Settings → Security (FR-010) ─────────────────────────────────────────

  @Get('sessions')
  @UseGuards(TrackingAuthGuard)
  sessions(@Req() req: Request) {
    return this.auth.listSessions(authOf(req)?.sid);
  }

  @Delete('sessions/:id')
  @UseGuards(TrackingAuthGuard)
  async revokeSession(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.revokeSession(id, authOf(req)?.sid, clientOf(req));
    if (r.current) clearSessionCookie(res, this.auth.production);
    return { ok: true, ...r };
  }

  @Post('sessions/revoke-all')
  @HttpCode(200)
  @UseGuards(TrackingAuthGuard)
  async revokeAll(@Body() dto: RevokeAllDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.revokeAll(authOf(req)?.sid, dto.includeCurrent === true, clientOf(req));
    if (r.current) clearSessionCookie(res, this.auth.production);
    return { ok: true, ...r };
  }

  @Get('events')
  @UseGuards(TrackingAuthGuard)
  events(@Query('limit') limit?: string) {
    const n = Number(limit);
    return this.auth.recentEvents(Number.isInteger(n) && n > 0 ? Math.min(n, 200) : 50);
  }

  private setCookie(res: Response, token: string): void {
    setSessionCookie(res, token, this.auth.cookieMaxAgeMs, this.auth.production);
  }

  private identityBody(p: JwtPayload) {
    return { tgUserId: p.sub, firstName: p.firstName, username: p.username };
  }
}
