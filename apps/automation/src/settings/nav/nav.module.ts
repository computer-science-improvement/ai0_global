import { Module } from '@nestjs/common';
import type { Pool } from 'pg';
import { DB_POOL } from '../../database/database.tokens';
import { AuthModule } from '../../auth/auth.module';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { NavConfigService } from './nav-config.service';
import { NAV_CONFIG, NavController } from './nav.controller';

/** Spec 027: /api/nav/* — the owner's dashboard menu (app_settings `ui.nav`). */
@Module({
  imports: [AuthModule],
  controllers: [NavController],
  providers: [
    TrackingAuthGuard,
    { provide: NAV_CONFIG, inject: [DB_POOL], useFactory: (pool: Pool) => new NavConfigService(pool) },
  ],
})
export class NavModule {}
