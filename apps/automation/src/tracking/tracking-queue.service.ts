import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker, Job, WorkerOptions, DelayedError } from 'bullmq';
import IORedis from 'ioredis';
import { REDIS } from './tracking.tokens';
import { isFloodWait } from '../common/telegram/flood-wait';
import {
  TRACKING_QUEUES, PollMetaJob, PollPostsJob, RefreshMetricsJob, ResolveDiscoveryJob,
} from './types';

/**
 * What a worker does with a job that hit (or was skipped by) a Telegram
 * FLOOD_WAIT:
 *   delay — park it as DELAYED for exactly the wait (one-shot jobs that would
 *           otherwise be lost, e.g. resolve-discovery);
 *   skip  — complete it, logged (periodic polls: the tier scheduler re-enqueues
 *           the channel next cycle since it wasn't marked polled — delaying
 *           those would pile up duplicates that all fire when the flood ends).
 */
export type FloodWaitPolicy = 'delay' | 'skip';

/**
 * Wrap a processor so a Telegram FLOOD_WAIT (from the MTProto client) is
 * handled per `policy` instead of failing into the normal 5s/10s exponential
 * backoff, which would hit Telegram again mid-flood and burn the job's
 * attempts. Other errors pass through untouched.
 */
export function withFloodWaitPolicy<T>(
  queueName: string,
  processor: (job: Job<T>) => Promise<unknown>,
  logger?: Logger,
  now: () => number = Date.now,
  policy: FloodWaitPolicy = 'delay',
): (job: Job<T>, token?: string) => Promise<unknown> {
  return async (job, token) => {
    try {
      return await processor(job);
    } catch (err) {
      const seconds = isFloodWait(err);
      if (seconds === null) throw err;
      if (policy === 'skip') {
        logger?.warn(`[${queueName}] job ${job.id} skipped — FLOOD_WAIT ${seconds}s`);
        return undefined;
      }
      if (!token) throw err;
      logger?.warn(`[${queueName}] job ${job.id} FLOOD_WAIT — delayed ${seconds}s`);
      await job.moveToDelayed(now() + seconds * 1000, token);
      throw new DelayedError();
    }
  };
}

@Injectable()
export class TrackingQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TrackingQueueService.name);
  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];

  constructor(@Inject(REDIS) private readonly redis: IORedis) {}

  async onModuleInit(): Promise<void> {
    for (const name of Object.values(TRACKING_QUEUES)) {
      this.queues.set(name, new Queue(name, { connection: this.redis }));
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const w of this.workers) await w.close();
    for (const q of this.queues.values()) await q.close();
  }

  async addPollMeta(data: PollMetaJob): Promise<void> {
    await this.queues.get(TRACKING_QUEUES.POLL_META)!.add('poll-meta', data, {
      removeOnComplete: 1000, removeOnFail: 1000, attempts: 3, backoff: { type: 'exponential', delay: 5000 },
    });
  }

  async addPollPosts(data: PollPostsJob): Promise<void> {
    await this.queues.get(TRACKING_QUEUES.POLL_POSTS)!.add('poll-posts', data, {
      removeOnComplete: 1000, removeOnFail: 1000, attempts: 3, backoff: { type: 'exponential', delay: 5000 },
    });
  }

  async addRefreshMetrics(data: RefreshMetricsJob): Promise<void> {
    await this.queues.get(TRACKING_QUEUES.REFRESH_METRICS)!.add('refresh-metrics', data, {
      removeOnComplete: 500, removeOnFail: 500, attempts: 2,
    });
  }

  async addResolveDiscovery(data: ResolveDiscoveryJob): Promise<void> {
    await this.queues.get(TRACKING_QUEUES.RESOLVE_DISCOVERY)!.add('resolve-discovery', data, {
      removeOnComplete: 100, removeOnFail: 100, attempts: 1,
    });
  }

  /**
   * Register a worker for one queue with concurrency cap. Workers are stored
   * so onModuleDestroy can close them cleanly.
   */
  registerWorker<T>(
    queueName: string,
    processor: (job: Job<T>) => Promise<unknown>,
    concurrency = 5,
    onFloodWait: FloodWaitPolicy = 'delay',
  ): void {
    const opts: WorkerOptions = { connection: this.redis, concurrency };
    const wrapped = withFloodWaitPolicy(queueName, processor, this.logger, Date.now, onFloodWait);
    const w = new Worker<T>(queueName, wrapped, opts);
    w.on('failed', (job, err) => this.logger.warn(`[${queueName}] job ${job?.id} failed: ${err.message}`));
    this.workers.push(w);
  }
}
