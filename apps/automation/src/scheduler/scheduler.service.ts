import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ChannelConfigService }    from '../config/channel-config.service';
import { ContentStrategyRunner }   from '../common/content-strategy/content-strategy.runner';
import { ContentStrategyRegistry } from '../common/content-strategy/content-strategy.registry';

@Injectable()
export class SchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchedulerService.name);

  /**
   * Per-strategy in-flight guard. Cron is dumb: it fires on schedule even if
   * the previous tick of the SAME strategy is still running (AI generation
   * can take 30-90s; if cron fires every 5 minutes and the strategy spans
   * more than 5 minutes for any reason, two ticks would otherwise overlap
   * and double-publish). Skipping the second tick is the right call —
   * the strategy will fire again on its next scheduled minute.
   */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly registry:         SchedulerRegistry,
    private readonly channelConfig:    ChannelConfigService,
    private readonly strategyRunner:   ContentStrategyRunner,
    private readonly strategyRegistry: ContentStrategyRegistry,
  ) {}

  onApplicationBootstrap() {
    this.registerStrategies();
  }

  private registerStrategies(): void {
    const bindings = this.channelConfig.resolveStrategyBindings();

    for (const binding of bindings) {
      const strategy = this.strategyRegistry.get(binding.type);
      if (!strategy) {
        this.logger.warn(`Strategy "${binding.type}" not found in registry — skipping`);
        continue;
      }

      const cronName = `strategy:${binding.id}`;
      this.scheduleCron(cronName, binding.schedule, () =>
        this.strategyRunner.run(strategy, binding.channelId, binding.params, binding.id),
      );
    }
  }

  private scheduleCron(name: string, schedule: string, handler: () => Promise<void>): void {
    const job = new CronJob(schedule, async () => {
      // Guard 1: previous tick of THIS strategy still running.
      if (this.inFlight.has(name)) {
        this.logger.warn(`Skipping ${name}: previous run still in flight`);
        return;
      }

      this.inFlight.add(name);
      this.logger.log(`Cron trigger: ${name}`);
      try {
        await handler();
      } catch (err: any) {
        this.logger.error(`${name} failed: ${err.message}`);
      } finally {
        this.inFlight.delete(name);
      }
    });

    this.registry.addCronJob(name, job);
    job.start();

    this.logger.log(`Scheduled "${name}": ${schedule}`);
  }
}
