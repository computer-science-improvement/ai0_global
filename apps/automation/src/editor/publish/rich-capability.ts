import type { Pool } from 'pg';
import { richUnsupportedKey } from '../repo/editor-channels.repository';

/**
 * Spec 033 FR-003: the per-channel "rich messages unsupported" flag. A hard
 * "unsupported" answer from Telegram switches rich messages off for the
 * channel for 7 days: the publisher then sends the stored HTML fallback
 * straight away and new renders are HTML (the card carries `richUnsupported`).
 * Stored in app_settings as `cap.tg_rich_unsupported:<channelKey>` = ISO time
 * until which the flag holds (no migration).
 */
export const RICH_UNSUPPORTED_TTL_MS = 7 * 86_400_000;

export interface RichCapability {
  isUnsupported(channelKey: string, now?: Date): Promise<boolean>;
  markUnsupported(channelKey: string, now?: Date): Promise<void>;
}

export class PgRichCapability implements RichCapability {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async isUnsupported(channelKey: string, now: Date = new Date()): Promise<boolean> {
    const { rows } = await this.pool.query(`SELECT value FROM app_settings WHERE key = $1`, [richUnsupportedKey(channelKey)]);
    const until = Date.parse(rows[0]?.value ?? '');
    return Number.isFinite(until) && until > now.getTime();
  }

  async markUnsupported(channelKey: string, now: Date = new Date()): Promise<void> {
    const until = new Date(now.getTime() + RICH_UNSUPPORTED_TTL_MS).toISOString();
    await this.pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [richUnsupportedKey(channelKey), until]);
  }
}

/** In-memory flag (tests, processes without a database). */
export class MemoryRichCapability implements RichCapability {
  readonly until = new Map<string, number>();
  async isUnsupported(channelKey: string, now: Date = new Date()): Promise<boolean> {
    return (this.until.get(channelKey) ?? 0) > now.getTime();
  }
  async markUnsupported(channelKey: string, now: Date = new Date()): Promise<void> {
    this.until.set(channelKey, now.getTime() + RICH_UNSUPPORTED_TTL_MS);
  }
}

/** A Bot API error answer (HTTP status, error_code, description). */
export interface TelegramAnswerError { status: number | null; code: number | null; description: string }

/** Pull the Telegram answer out of an axios error or an `ok: false` body. */
export function telegramAnswer(err: any): TelegramAnswerError | null {
  const data = err?.telegram ?? err?.response?.data;
  const status = err?.response?.status ?? null;
  if (!data && status == null) return null;
  return { status, code: data?.error_code ?? status ?? (data?.ok === false ? 400 : null), description: String(data?.description ?? err?.message ?? '') };
}

const UNSUPPORTED_RE = /not supported|unsupported|method not found|not implemented|rich messages? (are |is )?(not|disabled|forbidden)|can't send rich|RICH_MESSAGE/i;

/**
 * How a failed rich call should be handled:
 * - `unsupported` — Telegram says the chat / bot / server cannot take rich
 *   messages (or the method does not exist): retry with HTML and flag the channel;
 * - `rejected` — any other definite Bad Request (size limit, a bad block):
 *   retry with HTML once, no flag;
 * - null — not a definite answer (network error, timeout, 429, 5xx): nothing
 *   is retried, because the message may already be out (no duplicates).
 */
export function classifyRichRejection(err: unknown): { kind: 'unsupported' | 'rejected'; reason: string } | null {
  const a = telegramAnswer(err);
  if (!a) return null;
  const code = a.code ?? a.status;
  if (code == null || code === 429 || code >= 500) return null;
  const reason = `${code}: ${a.description}`.slice(0, 500);
  if (code === 404 || UNSUPPORTED_RE.test(a.description)) return { kind: 'unsupported', reason };
  if (code >= 400 && code < 500) return { kind: 'rejected', reason };
  return null;
}
