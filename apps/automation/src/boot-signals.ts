/**
 * Spec 070 FR-005: a stop that arrives while Nest is still booting.
 *
 * `app.enableShutdownHooks()` is what makes the service answer SIGTERM, and it runs only after the modules are built (the
 * settings overlay, the database pool and every onModuleInit come first). In a container the service is PID 1, which has no
 * default action for SIGTERM, so a `docker stop` / `docker compose restart` that lands in that window is ignored until
 * Docker gives up after 10 s and sends SIGKILL, in the middle of a migration check or a half-done onModuleInit. The deploy
 * used to do exactly that: `up -d` followed at once by `restart`.
 *
 * `armBootSignals` is called before anything slow starts: a SIGTERM or SIGINT then logs «shutdown during boot» and exits
 * with 143 at once. The returned function removes both listeners, and main.ts calls it right before
 * `enableShutdownHooks()` so Nest's graceful stop takes over.
 */
export const BOOT_SIGNALS = ['SIGTERM', 'SIGINT'] as const;
/** 128 + SIGTERM(15): the code a process stopped by SIGTERM reports. */
export const BOOT_EXIT_CODE = 143;

/** The part of `process` the handler uses, so a test can pass an EventEmitter. */
export interface SignalTarget {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
}

export function armBootSignals(
  log: (message: string) => void,
  exit: (code: number) => void = (code) => process.exit(code),
  target: SignalTarget = process,
): () => void {
  const armed = BOOT_SIGNALS.map((signal) => {
    const listener = () => {
      log(`shutdown during boot (${signal})`);
      exit(BOOT_EXIT_CODE);
    };
    target.once(signal, listener);
    return { signal, listener };
  });
  return () => { for (const { signal, listener } of armed) target.removeListener(signal, listener); };
}
