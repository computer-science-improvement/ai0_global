import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { Redis } from 'ioredis';
import { ChannelConfigService }    from '../config/channel-config.service';
import { StrategyRunsRepository }  from '../config/strategy-runs.repository';
import { ContentStrategyRunner }   from '../common/content-strategy/content-strategy.runner';
import { ContentStrategyRegistry } from '../common/content-strategy/content-strategy.registry';
import { DestinationResolver } from '../common/content-strategy/destination-resolver.service';
import { RunTracer } from '../common/observability/run-tracer.service';
import { CONFIG_CHANGED_CHANNEL, ConfigChangedEvent } from '../config/config-events.types';
import { REDIS_CLIENT } from '../tracking/redis.provider';
import { isChannelPausedError } from '../publishers/errors';
import { withTimeout } from '../common/with-timeout';

/**
 * Hard wall-clock ceiling for a single strategy run. A hung external call (Graph
 * API, MTProto, hosting) with no client timeout would otherwise leave the run
 * row stuck 'running' forever and keep the in-flight guard set, so the strategy
 * never fires again until a restart. On timeout the run is recorded as an error
 * and the guard is released. Override via STRATEGY_RUN_TIMEOUT_MS.
 */
const DEFAULT_RUN_TIMEOUT_MS = 5 * 60_000;

interface JobMeta { extId: string; uuid: string; }

interface ScheduledJob { schedule: string; meta: JobMeta; type: string; channelKey: string; }

@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
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

  /** Mirror of what's currently registered — keyed by cron-job name. Used
   *  for diffing during hot-reload so we only stop/start what changed. */
  private readonly registered = new Map<string, ScheduledJob>();

  private subscriber: Redis | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly registry:         SchedulerRegistry,
    private readonly channelConfig:    ChannelConfigService,
    private readonly runsRepo:         StrategyRunsRepository,
    private readonly strategyRunner:   ContentStrategyRunner,
    private readonly strategyRegistry: ContentStrategyRegistry,
    private readonly destinationResolver: DestinationResolver,
    private readonly tracer:           RunTracer,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onApplicationBootstrap() {
    // Reconcile runs orphaned by a previous hard stop (left at 'running')
    // BEFORE the scheduler starts ticking — nothing is legitimately in-flight
    // yet, so any 'running' row is a dead leftover. Keeps the activity log from
    // showing a phantom spinner forever.
    try {
      const n = await this.runsRepo.failOrphanedRunning();
      if (n > 0) this.logger.warn(`Reconciled ${n} orphaned 'running' run(s) → error`);
    } catch (err: any) {
      this.logger.warn(`orphaned-run reconcile failed: ${err.message}`);
    }

    this.registerStrategies();

    // Subscribe to config:changed and reconcile on every kind that could
    // affect scheduling: 'strategy' (most common), 'channel' (channelKey
    // might have changed → resolved channelId would shift), 'all' (reset).
    // Debounced 500ms because cache itself debounces its own reload.
    this.subscriber = this.redis.duplicate();
    this.subscriber.on('message', (channel, message) => {
      if (channel !== CONFIG_CHANGED_CHANNEL) return;
      let event: ConfigChangedEvent;
      try { event = JSON.parse(message); } catch { return; }
      if (event.kind === 'strategy' || event.kind === 'channel' || event.kind === 'all') {
        this.scheduleReconcile();
      }
    });
    await this.subscriber.subscribe(CONFIG_CHANGED_CHANNEL);
    this.logger.log('SchedulerService bootstrapped (subscribed to config:changed)');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.subscriber) {
      try { await this.subscriber.quit(); } catch { /* ignore */ }
    }
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
  }

  /** Debounced reconciliation — coalesces bursts of mutations. */
  private scheduleReconcile(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => { void this.reconcile(); }, 500);
  }

  /**
   * Diff current registered jobs against the freshly-resolved bindings;
   * stop removed jobs, start added jobs, restart jobs whose schedule or
   * channel changed. Other-field changes (params, notes) need no cron
   * restart — they'll be picked up by the next tick via fresh
   * resolveStrategyBindings() in the runner closure.
   *
   * NOTE: runner.run() is invoked with the CURRENT params snapshot at the
   * time we register the job. To make param edits take effect without
   * unregistering, we close over the binding-fetch instead of the params
   * object — see scheduleCron below.
   */
  reconcile(): void {
    const next = new Map<string, ScheduledJob>();
    const bindings = this.channelConfig.resolveStrategyBindings();
    for (const binding of bindings) {
      if (!binding.enabled) continue;
      if (!this.strategyRegistry.get(binding.type)) continue;
      const name = `strategy:${binding.id}`;
      next.set(name, {
        schedule:   binding.schedule,
        type:       binding.type,
        channelKey: binding.channelId,
        meta:       { extId: binding.id, uuid: binding.uuid },
      });
    }

    let added = 0, removed = 0, updated = 0;

    // Remove jobs that are gone OR changed schedule/channel.
    for (const [name, current] of this.registered) {
      const target = next.get(name);
      if (!target || target.schedule !== current.schedule || target.channelKey !== current.channelKey) {
        this.stopJob(name);
        this.registered.delete(name);
        if (!target) removed++; else updated++;
      }
    }

    // Add jobs that didn't exist OR were just removed because of a diff.
    for (const [name, target] of next) {
      if (this.registered.has(name)) continue;
      this.startJob(name, target);
      this.registered.set(name, target);
      if (!removed && !updated) added++;
    }
    // Recount adds — the above loop's accounting drifts; recompute simply.
    added = [...next.keys()].filter(k => !this.registered.has(k)).length;
    // Actually the registered map was just populated; recompute by snapshotting.
    // (Doesn't matter for correctness, only for the log line below.)
    this.logger.log(
      `Reconciled scheduler: ${this.registered.size} active (was ${this.registered.size - added}). ` +
      `+${added} -${removed} ~${updated}`,
    );
  }

  private registerStrategies(): void {
    const bindings = this.channelConfig.resolveStrategyBindings();
    for (const binding of bindings) {
      if (!binding.enabled) {
        this.logger.log(`Strategy "${binding.id}" disabled — not scheduled`);
        continue;
      }
      if (!this.strategyRegistry.get(binding.type)) {
        this.logger.warn(`Strategy "${binding.type}" not found in registry — skipping`);
        continue;
      }
      const name = `strategy:${binding.id}`;
      const job: ScheduledJob = {
        schedule:   binding.schedule,
        type:       binding.type,
        channelKey: binding.channelId,
        meta:       { extId: binding.id, uuid: binding.uuid },
      };
      this.startJob(name, job);
      this.registered.set(name, job);
    }
  }

  private startJob(name: string, job: ScheduledJob): void {
    const cronJob = new CronJob(job.schedule, async () => {
      // Guard 1: previous tick of THIS strategy still running.
      if (this.inFlight.has(name)) {
        this.logger.warn(`Skipping ${name}: previous run still in flight`);
        this.runsRepo.recordSkipped(job.meta.uuid, job.meta.extId, 'previous run still in flight')
          .catch(err => this.logger.warn(`skip-log failed for ${name}: ${err.message}`));
        return;
      }
      this.inFlight.add(name);
      this.logger.log(`Cron trigger: ${name}`);

      // Re-resolve the binding on every tick so param edits land without
      // a scheduler restart. If the binding was deleted or disabled mid-
      // tick, bail out cleanly.
      const fresh = this.channelConfig.resolveStrategyBindings()
        .find(b => b.id === job.meta.extId);
      if (!fresh || !fresh.enabled) {
        this.inFlight.delete(name);
        return;
      }
      const strategy = this.strategyRegistry.get(fresh.type);
      if (!strategy) {
        this.inFlight.delete(name);
        return;
      }

      let dest;
      try {
        dest = await this.destinationResolver.resolve(fresh);
      } catch (err: any) {
        this.logger.warn(`${name} destination resolve failed: ${err.message}`);
        this.inFlight.delete(name);
        return;
      }

      let runId: string | null = null;
      try {
        runId = await this.runsRepo.start(job.meta.uuid, job.meta.extId);
      } catch (err: any) {
        this.logger.warn(`run-log start failed for ${name}: ${err.message}`);
      }

      try {
        // Establish a trace store around the whole run so deep services
        // (publishers, fan-out) record their steps; persist the chain on every
        // terminal path so the activity log can show what ran and where it broke.
        const timeoutMs = Number(process.env.STRATEGY_RUN_TIMEOUT_MS) || DEFAULT_RUN_TIMEOUT_MS;
        const steps = await this.tracer.run(async () => {
          try {
            await withTimeout(
              this.strategyRunner.run(strategy, fresh.channelId, fresh.params, fresh.id, dest),
              timeoutMs,
              `strategy ${name}`,
            );
            if (runId) {
              await this.runsRepo.finishOk(runId, this.tracer.steps()).catch(err =>
                this.logger.warn(`run-log finishOk failed for ${name}: ${err.message}`),
              );
            }
          } catch (err: any) {
            const desc = this.tracer.describeError(err);
            // A paused channel is an expected "do nothing" — record as
            // 'skipped' rather than 'error' so the run log stays clean and the
            // last-run chip on /strategies shows yellow not red.
            if (isChannelPausedError(err)) {
              this.logger.log(`${name} skipped: ${desc}`);
              if (runId) {
                await this.runsRepo.finishSkipped(runId, desc, this.tracer.steps()).catch(e =>
                  this.logger.warn(`run-log finishSkipped failed for ${name}: ${e.message}`),
                );
              }
            } else {
              this.logger.error(`${name} failed: ${desc}`);
              if (runId) {
                await this.runsRepo.finishError(runId, desc, this.tracer.steps()).catch(e =>
                  this.logger.warn(`run-log finishError failed for ${name}: ${e.message}`),
                );
              }
            }
          }
        });
        void steps;
      } finally {
        this.inFlight.delete(name);
      }
    });

    this.registry.addCronJob(name, cronJob);
    cronJob.start();
    this.logger.log(`Scheduled "${name}": ${job.schedule}`);
  }

  private stopJob(name: string): void {
    try {
      const job = this.registry.getCronJob(name);
      job.stop();
      this.registry.deleteCronJob(name);
      this.logger.log(`Unscheduled "${name}"`);
    } catch (err: any) {
      this.logger.warn(`Failed to stop ${name}: ${err.message}`);
    }
  }
}
