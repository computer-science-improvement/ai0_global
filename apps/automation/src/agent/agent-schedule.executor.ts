import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { ScheduledPostsRepository } from '../scheduled-posts/scheduled-posts.repository';
import { EditorPlansRepository } from '../editor/repo/editor-plans.repository';
import { EditorChannelsRepository } from '../editor/repo/editor-channels.repository';
import { AdOrdersRepository } from '../payments/ad-orders.repository';
import { AdPlacement, AdPlacementPorts, ChannelRef, Placement } from './ad-placement';

/** tracked channel by uuid or channel_key, with the bot that publishes for it (own bot, else the default bot). */
export async function channelRefFromDb(pool: Pick<Pool, 'query'>, idOrKey: string): Promise<ChannelRef | null> {
  const { rows } = await pool.query(
    `SELECT tc.id, tc.channel_key, COALESCE(tc.bot_id, (SELECT id FROM my_bots WHERE is_default LIMIT 1)) AS bot_id
       FROM tracked_channels tc
      WHERE tc.id::text = $1 OR tc.channel_key = $1
      LIMIT 1`,
    [idOrKey]);
  const r = rows[0];
  return r ? { trackedId: r.id, channelKey: r.channel_key ?? null, botId: r.bot_id ?? null } : null;
}

/** Executes an approved schedule_post action — see AdPlacement for the reserved-slot vs scheduled_posts precedence. */
@Injectable()
export class AgentScheduleExecutor {
  private readonly placement: AdPlacement;

  constructor(
    posts: ScheduledPostsRepository,
    @Inject(DB_POOL) pool: Pool,
    config: ConfigService,
  ) {
    const plans = new EditorPlansRepository(pool);
    const cards = new EditorChannelsRepository(pool);
    const orders = new AdOrdersRepository(pool);
    const ports: AdPlacementPorts = {
      editorEnabled:       () => config.get<string>('EDITOR_ENABLED') === 'true',
      channelRef:          (k) => channelRefFromDb(pool, k),
      card:                (k) => cards.get(k),
      reserveSlot:         (i) => plans.reserveSlot(i),
      createScheduledPost: (p) => posts.create(p),
      findOrder:           (id) => orders.findById(id),
      setPlacement:        (id, p) => orders.setPlacement(id, p),
    };
    this.placement = new AdPlacement(ports);
  }

  schedule(input: { channelId: string; text: string; scheduledAt: string; orderId?: string | null }): Promise<Placement> {
    return this.placement.place(input);
  }
}
