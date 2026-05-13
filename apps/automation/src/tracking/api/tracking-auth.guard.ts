import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TrackingAuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const expected = this.config.get<string>('TRACKING_TOKEN') ?? '';
    if (!expected) return true; // dev mode — no token configured

    const req = ctx.switchToHttp().getRequest();
    const auth = req.headers['authorization'] ?? '';
    const got = typeof auth === 'string' ? auth.replace(/^Bearer\s+/i, '').trim() : '';
    if (got && got === expected) return true;

    throw new UnauthorizedException('Invalid or missing tracking token');
  }
}
