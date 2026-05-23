import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ChannelConfigService }    from '../config/channel-config.service';
import { StrategyRunsRepository }  from '../config/strategy-runs.repository';
import { ContentStrategyRunner }   from '../common/content-strategy/content-strategy.runner';
import { ContentStrategyRegistry } from '../common/content-strategy/content-strategy.registry';

interface JobMeta { extId: string; uuid: string; }

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
    private readonly runsRepo:         StrategyRunsRepository,
    private readonly strategyRunner:   ContentStrategyRunner,
    private readonly strategyRegistry: ContentStrategyRegistry,
  ) {}

  onApplicationBootstrap() {
    this.registerStrategies();
  }

  private registerStrategies(): void {
    const bindings = this.channelConfig.resolveStrategyBindings();

    for (const binding of bindings) {
      if (!binding.enabled) {
        this.logger.log(`Strategy "${binding.id}" disabled — not scheduled`);
        continue;
      }
      const strategy = this.strategyRegistry.get(binding.type);
      if (!strategy) {
        this.logger.warn(`Strategy "${binding.type}" not found in registry — skipping`);
        continue;
      }

      const cronName = `strategy:${binding.id}`;
      this.scheduleCron(
        cronName,
        binding.schedule,
        { extId: binding.id, uuid: binding.uuid },
        () => this.strategyRunner.run(strategy, binding.channelId, binding.params, binding.id),
      );
    }
  }

  private scheduleCron(
    name: string,
    schedule: string,
    meta: JobMeta,
    handler: () => Promise<void>,
  ): void {
    const job = new CronJob(schedule, async () => {
      // Guard 1: previous tick of THIS strategy still running.
      if (this.inFlight.has(name)) {
        this.logger.warn(`Skipping ${name}: previous run still in flight`);
        // Log skip with best-effort — DB failure here mustn't tank the worker.
        this.runsRepo.recordSkipped(meta.uuid, meta.extId, 'previous run still in flight')
          .catch(err => this.logger.warn(`skip-log failed for ${name}: ${err.message}`));
        return;
      }

      this.inFlight.add(name);
      this.logger.log(`Cron trigger: ${name}`);

      // Start a run row — if this insert fails, still try to run the strategy;
      // we just won't have a row to update on completion (logged below).
      let runId: string | null = null;
      try {
        runId = await this.runsRepo.start(meta.uuid, meta.extId);
      } catch (err: any) {
        this.logger.warn(`run-log start failed for ${name}: ${err.message}`);
      }

      try {
        await handler();
        if (runId) {
          await this.runsRepo.finishOk(runId).catch(err =>
            this.logger.warn(`run-log finishOk failed for ${name}: ${err.message}`),
          );
        }
      } catch (err: any) {
        this.logger.error(`${name} failed: ${err.message}`);
        if (runId) {
          await this.runsRepo.finishError(runId, err.message ?? String(err)).catch(e =>
            this.logger.warn(`run-log finishError failed for ${name}: ${e.message}`),
          );
        }
      } finally {
        this.inFlight.delete(name);
      }
    });

    this.registry.addCronJob(name, job);
    job.start();

    this.logger.log(`Scheduled "${name}": ${schedule}`);
  }
}
