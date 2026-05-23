import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type IORedis from 'ioredis';
import { REDIS_CLIENT } from '../tracking/redis.provider';
import { CONFIG_CHANGED_CHANNEL } from './config-events.types';
import { MyBotsRepository, MyBotRow } from './my-bots.repository';
import {
  TrackedChannelsConfigRepository,
  TrackedChannelConfigRow,
} from './tracked-channels.repository';
import {
  StrategyBindingsRepository,
  StrategyBindingRow,
} from './strategy-bindings.repository';
import {
  ForwardRoutesRepository,
  ForwardRouteRow,
} from './forward-routes.repository';

@Injectable()
export class ConfigCacheService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ConfigCacheService.name);

  private bots:        MyBotRow[]                    = [];
  private botsById     = new Map<string, MyBotRow>();
  private botsByBotId  = new Map<string, MyBotRow>();

  private channels:        TrackedChannelConfigRow[]            = [];
  private channelsById     = new Map<string, TrackedChannelConfigRow>();
  private channelsByKey    = new Map<string, TrackedChannelConfigRow>();

  private bindings:        StrategyBindingRow[]                 = [];
  private bindingsById     = new Map<string, StrategyBindingRow>();
  private bindingsByExtId  = new Map<string, StrategyBindingRow>();

  private routes:          ForwardRouteRow[]                    = [];
  private routesBySource   = new Map<string, ForwardRouteRow[]>();

  private subscriber: IORedis | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private readonly RELOAD_DEBOUNCE_MS = 500;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: IORedis,
    private readonly botsRepo:     MyBotsRepository,
    private readonly channelsRepo: TrackedChannelsConfigRepository,
    private readonly bindingsRepo: StrategyBindingsRepository,
    private readonly routesRepo:   ForwardRoutesRepository,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.reload();

    // ioredis disallows commands on a subscribed connection — duplicate it
    // so the rest of the app's redis usage (publish, queues, etc.) keeps
    // working on the original client.
    this.subscriber = this.redis.duplicate();
    this.subscriber.on('error', (e) => {
      this.logger.warn(`config subscriber error: ${e.message}`);
    });

    await this.subscriber.subscribe(CONFIG_CHANGED_CHANNEL);
    this.subscriber.on('message', (channel, message) => {
      if (channel !== CONFIG_CHANGED_CHANNEL) return;
      this.logger.log(`received ${CONFIG_CHANGED_CHANNEL}: ${message}`);
      this.scheduleReload();
    });
    this.logger.log(`subscribed to ${CONFIG_CHANGED_CHANNEL}`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    if (this.subscriber) {
      try {
        await this.subscriber.unsubscribe(CONFIG_CHANGED_CHANNEL);
        await this.subscriber.quit();
      } catch (e: any) {
        this.logger.warn(`subscriber teardown error: ${e?.message ?? String(e)}`);
      }
      this.subscriber = null;
    }
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      void this.reload().catch((e) =>
        this.logger.warn(`reload failed: ${e?.message ?? String(e)}`),
      );
    }, this.RELOAD_DEBOUNCE_MS);
  }

  async reload(): Promise<void> {
    const [bots, channels, bindings, routes] = await Promise.all([
      this.botsRepo.list(),
      this.channelsRepo.list(),
      this.bindingsRepo.list(),
      this.routesRepo.list(),
    ]);

    this.bots         = bots;
    this.botsById     = new Map(bots.map((b) => [b.id, b]));
    this.botsByBotId  = new Map(bots.map((b) => [b.botId, b]));

    this.channels        = channels;
    this.channelsById    = new Map(channels.map((c) => [c.id, c]));
    this.channelsByKey   = new Map(
      channels.filter((c) => c.channelKey !== null).map((c) => [c.channelKey as string, c]),
    );

    this.bindings        = bindings;
    this.bindingsById    = new Map(bindings.map((b) => [b.id, b]));
    this.bindingsByExtId = new Map(bindings.map((b) => [b.extId, b]));

    this.routes          = routes;
    this.routesBySource  = new Map();
    for (const r of routes) {
      const list = this.routesBySource.get(r.sourceChannelId) ?? [];
      list.push(r);
      this.routesBySource.set(r.sourceChannelId, list);
    }

    this.logger.log(
      `cache reloaded: ${bots.length} bot(s), ${channels.length} channel(s), ` +
      `${bindings.length} binding(s), ${routes.length} route(s)`,
    );
  }

  // ── Bots ─────────────────────────────────────────────────────────────────
  listBots(): MyBotRow[] { return this.bots; }
  getBotById(id: string): MyBotRow | null { return this.botsById.get(id) ?? null; }
  getBotByBotId(botId: string): MyBotRow | null { return this.botsByBotId.get(botId) ?? null; }

  // ── Channels ─────────────────────────────────────────────────────────────
  listChannels(): TrackedChannelConfigRow[] { return this.channels; }
  getChannelById(id: string): TrackedChannelConfigRow | null {
    return this.channelsById.get(id) ?? null;
  }
  getChannelByKey(key: string): TrackedChannelConfigRow | null {
    return this.channelsByKey.get(key) ?? null;
  }

  // ── Strategy bindings ────────────────────────────────────────────────────
  listBindings(): StrategyBindingRow[] { return this.bindings; }
  getBindingById(id: string): StrategyBindingRow | null {
    return this.bindingsById.get(id) ?? null;
  }
  getBindingByExtId(extId: string): StrategyBindingRow | null {
    return this.bindingsByExtId.get(extId) ?? null;
  }

  // ── Forward routes ───────────────────────────────────────────────────────
  listForwardRoutes(): ForwardRouteRow[] { return this.routes; }
  getForwardRoutesForSource(sourceChannelId: string): ForwardRouteRow[] {
    return this.routesBySource.get(sourceChannelId) ?? [];
  }
}
