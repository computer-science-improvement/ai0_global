import { Module } from '@nestjs/common';
import type { Pool } from 'pg';
import { DB_POOL } from '../../database/database.tokens';
import { AuthModule } from '../../auth/auth.module';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { NavConfigService } from './nav-config.service';
import { NavBadgesService } from './nav-badges.service';
import { NavAttentionService } from './nav-attention.service';
import { NAV_ATTENTION, NAV_BADGES, NAV_CONFIG, NavController } from './nav.controller';

/** Spec 027: /api/nav/* — the owner's dashboard menu (app_settings `ui.nav`) and its counters. */
@Module({
  imports: [AuthModule],
  controllers: [NavController],
  providers: [
    TrackingAuthGuard,
    { provide: NAV_CONFIG, inject: [DB_POOL], useFactory: (pool: Pool) => new NavConfigService(pool) },
    { provide: NAV_BADGES, inject: [DB_POOL], useFactory: (pool: Pool) => new NavBadgesService(pool) },
    { provide: NAV_ATTENTION, inject: [DB_POOL], useFactory: (pool: Pool) => new NavAttentionService(pool) },
  ],
})
export class NavModule {}
