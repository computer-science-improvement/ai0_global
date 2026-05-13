import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../../auth/auth.service';

@Injectable()
export class TrackingAuthGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly auth:   AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();

    // 1. Bearer token (dev/debug path)
    const expected = this.config.get<string>('TRACKING_TOKEN') ?? '';
    const auth = req.headers['authorization'] ?? '';
    const got = typeof auth === 'string' ? auth.replace(/^Bearer\s+/i, '').trim() : '';
    if (expected && got === expected) return true;

    // 2. JWT cookie (production path)
    const token = req.cookies?.tracking_jwt;
    if (token) {
      const payload = await this.auth.verifyToken(token);
      if (payload) { req.user = payload; return true; }
    }

    // Dev mode: no token configured AND no cookie → bypass for local
    if (!expected && !token) return true;

    throw new UnauthorizedException('Invalid or missing credentials');
  }
}
