// flood-wait.ts — detect Telegram FLOOD_WAIT on MTProto (GramJS) errors and
// keep a per-account "don't touch Telegram until …" window.
//
// Why not a message regex: GramJS's FloodWaitError carries `seconds`, its
// `message` is "A wait of N seconds is required…", and its `errorMessage` is
// the base-class constant 'FLOOD'. The old `err.errorMessage ?? err.message`
// + regex therefore always tested the string 'FLOOD' and never fired — the
// account kept hammering Telegram while flood-limited (ban risk).
import { errors } from 'telegram';

/** Used when Telegram reports a flood but no wait length (bare 420 FLOOD). */
export const DEFAULT_FLOOD_SECONDS = 60;

const FLOOD_MSG_RE = /FLOOD(?:_PREMIUM|_TEST_PHONE)?_WAIT_(\d+)|A wait of (\d+) seconds is required/;

/**
 * Thrown by our MTProto clients when Telegram flood-limits the account, and
 * while the flood window is still open (calls are skipped, not sent). Carries
 * `floodWaitSeconds` so BullMQ workers can delay the job by that amount.
 */
export class FloodWaitActiveError extends Error {
  readonly floodWaitSeconds: number;
  constructor(seconds: number, where: string) {
    super(`FLOOD_WAIT ${seconds}s (${where})`);
    this.name = 'FloodWaitActiveError';
    this.floodWaitSeconds = seconds;
  }
}

function finiteSeconds(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.ceil(v) : null;
}

/**
 * Seconds to wait when `err` is an account-level flood-wait, else null.
 * Checks, in order: our own FloodWaitActiveError, the GramJS error class
 * (FloodError subclasses / class name), `errorMessage === 'FLOOD'`, and
 * finally the message text. Per-chat SLOWMODE_WAIT is not an account flood.
 */
export function isFloodWait(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as Record<string, any>;

  const own = finiteSeconds(e.floodWaitSeconds);
  if (own !== null) return own;

  const name = e.constructor?.name ?? '';
  if (err instanceof errors.SlowModeWaitError || name === 'SlowModeWaitError') return null;

  const floodClass = err instanceof errors.FloodError || /^Flood.*Error$/.test(name);
  if (floodClass || e.errorMessage === 'FLOOD') {
    return finiteSeconds(e.seconds) ?? secondsFromMessage(e) ?? DEFAULT_FLOOD_SECONDS;
  }
  return secondsFromMessage(e);
}

function secondsFromMessage(e: Record<string, any>): number | null {
  const text = `${e.errorMessage ?? ''} ${e.message ?? ''}`;
  const m = FLOOD_MSG_RE.exec(text);
  return m ? parseInt(m[1] ?? m[2], 10) : null;
}

/**
 * Per-account skip window. `trip(s)` opens/extends it (never shortens);
 * `remaining()` is the whole seconds left, 0 when closed.
 */
export class FloodWindow {
  private until = 0;
  constructor(private readonly now: () => number = Date.now) {}

  trip(seconds: number): void {
    this.until = Math.max(this.until, this.now() + seconds * 1000);
  }

  remaining(): number {
    const ms = this.until - this.now();
    return ms > 0 ? Math.ceil(ms / 1000) : 0;
  }
}
