// run-tracer.service.ts — an ambient, per-run execution tracer.
//
// A run's steps are recorded into an AsyncLocalStorage store established by the
// scheduler around the whole run (`run()`), so any service deep in the call
// stack (publishers, fan-out) can add a step via `span()` / `event()` WITHOUT
// threading a tracer argument through every signature. When no store is active
// (unit tests, manual calls) the methods degrade to a plain passthrough — zero
// behavioural coupling.
import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { describeError } from './describe-error';

export type StepStatus = 'ok' | 'error' | 'skipped';

export interface RunStep {
  seq:        number;
  service:    string;
  action:     string;
  status:     StepStatus;
  durationMs: number;
  detail?:    string;
  error?:     string;
}

interface Store {
  steps: RunStep[];
  seq:   number;
}

@Injectable()
export class RunTracer {
  private readonly als = new AsyncLocalStorage<Store>();

  /** Establish a fresh trace store for the duration of `fn`. Returns the
   *  collected steps so the caller can persist them. */
  async run<T>(fn: () => Promise<T>): Promise<RunStep[]> {
    const store: Store = { steps: [], seq: 0 };
    await this.als.run(store, fn);
    return store.steps;
  }

  /** Steps collected in the current run, or [] when no run is active. */
  steps(): RunStep[] {
    return this.als.getStore()?.steps ?? [];
  }

  /**
   * Wrap an operation as a timed step: pushes an `ok` step on success, an
   * `error` step (well-described) on throw — then RETHROWS so control flow is
   * unchanged. Outside a run it just runs `fn` (passthrough).
   */
  async span<T>(service: string, action: string, fn: () => Promise<T>, detail?: string): Promise<T> {
    const store = this.als.getStore();
    if (!store) return fn();
    const startedAt = performance.now();
    try {
      const out = await fn();
      this.push(store, { service, action, status: 'ok', durationMs: ms(startedAt), detail });
      return out;
    } catch (err) {
      this.push(store, { service, action, status: 'error', durationMs: ms(startedAt), detail, error: describeError(err) });
      throw err;
    }
  }

  /**
   * Record a point-in-time step WITHOUT rethrowing — for outcomes that are
   * handled in place (e.g. an isolated fan-out target that failed but must not
   * block the others). `info` is a success detail or, for error status, an
   * Error/message to describe. No-op outside a run.
   */
  event(service: string, action: string, status: StepStatus, info?: unknown, durationMs = 0): void {
    const store = this.als.getStore();
    if (!store) return;
    const step: Omit<RunStep, 'seq'> = { service, action, status, durationMs };
    if (status === 'error') step.error = describeError(info);
    else if (info != null) step.detail = String(info);
    this.push(store, step);
  }

  /** Expose the shared error formatter so callers (scheduler) describe uniformly. */
  describeError(err: unknown): string {
    return describeError(err);
  }

  private push(store: Store, step: Omit<RunStep, 'seq'>): void {
    store.steps.push({ seq: store.seq++, ...step });
  }
}

function ms(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}
