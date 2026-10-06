import { CanActivate, ExecutionContext, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../../auth/auth.service';
import { setSessionCookie } from '../../auth/auth-cookie';

const MESSAGES: Record<string, string> = {
  no_credentials:  'Invalid or missing credentials',
  bad_token:       'Invalid or missing credentials',
  session_expired: 'Session expired',
  session_revoked: 'Session revoked',
  session_legacy:  'Session from an older version; sign in again',
};

/**
 * Guards the admin API. All the logic lives in `AuthService.authenticate()`
 * (Bearer TRACKING_TOKEN → session cookie → explicit local dev bypass), shared
 * with `/auth/me` and `/auth/check` (spec 028 FR-003). A 401 carries `{code}`
 * so the dashboard can say why; a session past its half-life gets a renewed
 * cookie on the way through.
 */
@Injectable()
export class TrackingAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const http = ctx.switchToHttp();
    const req = http.getRequest();
    const r = await this.auth.authenticate(req);

    if (r.ok) {
      const { ok: _ok, ...auth } = r;
      req.user = auth.identity;
      req.auth = auth;
      if (r.renewToken) {
        setSessionCookie(http.getResponse(), r.renewToken, this.auth.cookieMaxAgeMs, this.auth.production);
      }
      return true;
    }
    if (r.code === 'unavailable') {
      throw new ServiceUnavailableException({ statusCode: 503, code: 'auth_unavailable', message: 'Sign-in check is temporarily unavailable' });
    }
    throw new UnauthorizedException({ statusCode: 401, code: r.code, message: MESSAGES[r.code] });
  }
}
