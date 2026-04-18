import {
  CanActivate,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Header-based API key guard. Compares `X-API-Key` against `STATS_API_KEY`.
 *
 * If `STATS_API_KEY` is not set, every request is rejected with 500. This is
 * intentional: never silently accept all traffic.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const expected = this.config.get<string>('STATS_API_KEY');
    if (!expected) {
      this.logger.error('STATS_API_KEY is not set — refusing all stats requests');
      throw new InternalServerErrorException('Stats API not configured');
    }

    const req = ctx.switchToHttp().getRequest();
    const provided =
      (req.headers['x-api-key'] as string | undefined) ??
      (req.headers['X-API-Key'] as string | undefined);

    if (provided !== expected) {
      throw new UnauthorizedException('Invalid or missing X-API-Key');
    }
    return true;
  }
}
