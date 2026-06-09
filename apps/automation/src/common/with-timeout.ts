/**
 * Reject if `promise` doesn't settle within `ms` milliseconds.
 *
 * The original promise is NOT cancelled — it's left to settle on its own
 * (most external clients, e.g. GramJS, expose no cancellation). Callers use
 * this to bound how long they wait on a possibly-stalled external call so a
 * dead socket can't hang a request handler indefinitely.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    // Don't let the timer keep the event loop (and thus the process) alive.
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}
