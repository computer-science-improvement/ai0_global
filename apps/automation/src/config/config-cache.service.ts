// apps/automation/src/config/config-cache.service.ts
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../tracking/redis.provider';
import { MyBotsRepository, MyBotRow } from './my-bots.repository';
import { TrackedChannelsConfigRepository, TrackedChannelConfigRow } from './tracked-channels.repository';
import { StrategyBindingsRepository, StrategyBindingRow } from './strategy-bindings.repository';
import { ForwardRoutesRepository, ForwardRouteRow } from './forward-routes.repository';
import { CONFIG_CHANGED_CHANNEL, ConfigChangedEvent } from './config-events.types';

@Injectable()
export class ConfigCacheService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ConfigCacheService.name);

  // Maps keyed by id (UUID) AND/OR by channel_key for fast lookup.
  private botsById:        Map<string, MyBotRow> = new Map();
  private botsByBotId:     Map<string, MyBotRow> = new Map();
  private channelsById:    Map<string, TrackedChannelConfigRow> = new Map();
  private channelsByKey:   Map<string, TrackedChannelConfigRow> = new Map();
  private bindings:        StrategyBindingRow[] = [];
  private forwardRoutes:   ForwardRouteRow[] = [];

  private subscriber: Redis | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly botsRepo:     MyBotsRepository,
    private readonly channelsRepo: TrackedChannelsConfigRepository,
    private readonly bindingsRepo: StrategyBindingsRepository,
    private readonly forwardsRepo: ForwardRoutesRepository,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.reload();
    // Subscriber must be a separate connection — duplicate the main client.
    this.subscriber = this.redis.duplicate();
    await this.subscriber.subscribe(CONFIG_CHANGED_CHANNEL);
    this.subscriber.on('message', (channel, message) => {
      if (channel !== CONFIG_CHANGED_CHANNEL) return;
      let event: ConfigChangedEvent;
      try { event = JSON.parse(message); }
      catch { return; }
      this.logger.debug(`config:changed received: ${event.kind} ${event.id ?? ''}`);
      this.scheduleReload();
    });
    this.logger.log('ConfigCacheService bootstrapped (subscribed to config:changed)');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.subscriber) {
      try { await this.subscriber.quit(); } catch { /* ignore */ }
    }
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
  }

  /** Debounced — coalesces bursts of mutations into one reload. */
  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => { void this.reload(); }, 500);
  }

  async reload(): Promise<void> {
    const [bots, channels, bindings, forwards] = await Promise.all([
      this.botsRepo.list(),
      this.channelsRepo.list(),
      this.bindingsRepo.list(),
      this.forwardsRepo.list(),
    ]);
    this.botsById = new Map(bots.map(b => [b.id, b]));
    this.botsByBotId = new Map(bots.map(b => [b.bot_id, b]));
    this.channelsById = new Map(channels.map(c => [c.id, c]));
    this.channelsByKey = new Map(channels.filter(c => c.channel_key).map(c => [c.channel_key!, c]));
    this.bindings = bindings;
    this.forwardRoutes = forwards;
    this.logger.debug(
      `Cache reloaded: ${bots.length} bots, ${channels.length} channels, ${bindings.length} bindings, ${forwards.length} forward routes`,
    );
  }

  // ── Getters ─────────────────────────────────────────────────────────────

  getAllBots(): MyBotRow[] { return [...this.botsById.values()]; }
  getBotById(id: string): MyBotRow | null { return this.botsById.get(id) ?? null; }
  getBotByBotId(botId: string): MyBotRow | null { return this.botsByBotId.get(botId) ?? null; }

  getAllChannels(): TrackedChannelConfigRow[] { return [...this.channelsById.values()]; }
  getChannelById(id: string): TrackedChannelConfigRow | null { return this.channelsById.get(id) ?? null; }
  getChannelByKey(key: string): TrackedChannelConfigRow | null { return this.channelsByKey.get(key) ?? null; }

  getBindings(): StrategyBindingRow[] { return [...this.bindings]; }
  getForwardRoutes(): ForwardRouteRow[] { return [...this.forwardRoutes]; }

  /** Forward routes whose source is the given channel id. */
  getForwardRoutesForSource(sourceChannelId: string): ForwardRouteRow[] {
    return this.forwardRoutes.filter(r => r.source_channel_id === sourceChannelId);
  }
}
