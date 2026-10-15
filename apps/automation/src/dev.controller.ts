/**
 * GET /health — basic health check.
 *
 * The dev-only `GET /trigger/:strategyType` (run a legacy strategy once) was removed with the strategy runtime
 * (spec 023 phase B); content is run by editor agents.
 */
import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Controller()
export class DevController {
  constructor(private readonly config: ConfigService) {}

  @Get('health')
  health() {
    return { status: 'ok', env: this.config.get('NODE_ENV', 'development') };
  }
}
