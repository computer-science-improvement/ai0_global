import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker, Job, WorkerOptions } from 'bullmq';
import IORedis from 'ioredis';
import { REDIS } from './tracking.tokens';
import {
  TRACKING_QUEUES, PollMetaJob, PollPostsJob, RefreshMetricsJob, ResolveDiscoveryJob,
} from './types';

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
  ): void {
    const opts: WorkerOptions = { connection: this.redis, concurrency };
    const w = new Worker<T>(queueName, processor, opts);
    w.on('failed', (job, err) => this.logger.warn(`[${queueName}] job ${job?.id} failed: ${err.message}`));
    this.workers.push(w);
  }
}
