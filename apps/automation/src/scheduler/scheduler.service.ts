import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ChannelConfigService }    from '../config/channel-config.service';
import { ContentStrategyRunner }   from '../common/content-strategy/content-strategy.runner';
import { ContentStrategyRegistry } from '../common/content-strategy/content-strategy.registry';

@Injectable()
export class SchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchedulerService.name);

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
      this.logger.log(`Cron trigger: ${name}`);
      await handler().catch((err) =>
        this.logger.error(`${name} failed: ${err.message}`),
      );
    });

    this.registry.addCronJob(name, job);
    job.start();

    this.logger.log(`Scheduled "${name}": ${schedule}`);
  }
}
