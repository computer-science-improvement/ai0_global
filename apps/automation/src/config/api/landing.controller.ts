// apps/automation/src/config/api/landing.controller.ts
// PUBLIC endpoint: no `@UseGuards`. Guards in this app are applied per-controller
// (no global APP_GUARD), so omitting the guard leaves this route unauthenticated.
// It exposes ONLY the LandingResource projection — never raw rows or tokens.
import { Controller, Get } from '@nestjs/common';
import { LandingResource, LandingResourcesService } from '../landing-resources.service';

@Controller('api/landing')
export class LandingController {
  constructor(private readonly landing: LandingResourcesService) {}

  @Get('resources')
  list(): Promise<LandingResource[]> {
    return this.landing.listPublic();
  }
}
