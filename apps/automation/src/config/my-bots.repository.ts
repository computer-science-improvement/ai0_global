// apps/automation/src/config/my-bots.repository.ts
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

export interface MyBotRow {
  id:                string;
  bot_id:            string;
  username:          string | null;
  first_name:        string | null;
  platform:          string;
  token_env:         string;
  // Encrypted token at rest (enc:v1:...). Non-null wins over token_env; null →
  // legacy env-var path.
  token_enc:         string | null;
  active:            boolean;
  // At most one bot may be the default (enforced by a partial unique index).
  // Used as the publish fallback when a channel has no bot bound.
  is_default:        boolean;
  last_verified_at:  Date | null;
  verify_error:      string | null;
  created_at:        Date;
}

export interface MyBotInsertInput {
  bot_id:    string;
  // Legacy env-var NAME — null when a token VALUE (token_enc) is supplied instead.
  token_env: string | null;
  // Encrypted token blob (enc:v1:...) — set when the operator entered a value.
  token_enc?: string | null;
  platform?: string;
}

@Injectable()
export class MyBotsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async list(): Promise<MyBotRow[]> {
    const { rows } = await this.pool.query<MyBotRow>(
      `SELECT * FROM my_bots ORDER BY created_at`,
    );
    return rows;
  }

  async findById(id: string): Promise<MyBotRow | null> {
    const { rows } = await this.pool.query<MyBotRow>(
      `SELECT * FROM my_bots WHERE id = $1`, [id],
    );
    return rows[0] ?? null;
  }

  async findByBotId(botId: string): Promise<MyBotRow | null> {
    const { rows } = await this.pool.query<MyBotRow>(
      `SELECT * FROM my_bots WHERE bot_id = $1`, [botId],
    );
    return rows[0] ?? null;
  }

  async insert(input: MyBotInsertInput): Promise<MyBotRow> {
    const { rows } = await this.pool.query<MyBotRow>(
      `INSERT INTO my_bots (bot_id, token_env, token_enc, platform)
       VALUES ($1, $2, $3, COALESCE($4, 'telegram'))
       RETURNING *`,
      [input.bot_id, input.token_env, input.token_enc ?? null, input.platform ?? null],
    );
    return rows[0];
  }

  /** Persist (or clear) the encrypted token blob for a bot. */
  async setTokenEnc(id: string, tokenEnc: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE my_bots SET token_enc = $2 WHERE id = $1`, [id, tokenEnc],
    );
  }

  async markVerified(id: string, meta: { username: string; first_name: string }): Promise<void> {
    await this.pool.query(
      `UPDATE my_bots
         SET username         = $2::text,
             first_name       = $3::text,
             last_verified_at = now(),
             verify_error     = NULL
       WHERE id = $1`,
      [id, meta.username, meta.first_name],
    );
  }

  async markVerifyError(id: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE my_bots SET verify_error = $2::text, last_verified_at = now() WHERE id = $1`,
      [id, error],
    );
  }

  async setActive(id: string, active: boolean): Promise<void> {
    await this.pool.query(`UPDATE my_bots SET active = $2 WHERE id = $1`, [id, active]);
  }

  /**
   * Toggle the default-bot flag. At most one bot may be default (a partial
   * unique index enforces this at the DB level). To make `id` the default we
   * must clear any existing default FIRST, otherwise the index rejects the
   * second `true`. Both UPDATEs run in one transaction so a reader never sees
   * zero defaults (or two) mid-swap. Toggling off is a single targeted UPDATE.
   */
  async setDefault(id: string, value: boolean): Promise<void> {
    if (!value) {
      await this.pool.query(`UPDATE my_bots SET is_default = false WHERE id = $1`, [id]);
      return;
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE my_bots SET is_default = false WHERE is_default`);
      await client.query(`UPDATE my_bots SET is_default = true WHERE id = $1`, [id]);
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async findDefault(): Promise<MyBotRow | null> {
    const { rows } = await this.pool.query<MyBotRow>(
      `SELECT * FROM my_bots WHERE is_default LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM my_bots WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }

  /**
   * Delete a bot AND unbind whatever still references it, in one transaction:
   * channels (`bot_id → NULL`, so they fall back to the default bot) and any
   * scheduled publications (that FK has no cascade and would otherwise block
   * the DELETE). Returns false if the bot did not exist.
   */
  async deleteWithUnbind(id: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE tracked_channels       SET bot_id = NULL WHERE bot_id = $1`, [id]);
      await client.query(`UPDATE scheduled_publications SET bot_id = NULL WHERE bot_id = $1`, [id]);
      const { rowCount } = await client.query(`DELETE FROM my_bots WHERE id = $1`, [id]);
      await client.query('COMMIT');
      return (rowCount ?? 0) > 0;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async countChannelsBound(id: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text FROM tracked_channels WHERE bot_id = $1`, [id],
    );
    return parseInt(rows[0].count, 10);
  }

  /**
   * Atomically check-and-delete: locks the bot row with `FOR UPDATE`, counts
   * bound channels under that lock, then deletes if the count is zero. Without
   * this, a count→delete sequence has a race where a concurrent UPDATE on
   * tracked_channels.bot_id slips in between the two queries — the FK uses
   * ON DELETE SET NULL, so a "successful" delete silently orphans channels.
   *
   * Returns:
   *   - { ok: true, deleted: true  } — deleted
   *   - { ok: false, bound: N }     — N channels still reference this bot
   *   - { ok: true, deleted: false } — bot did not exist
   */
  async deleteIfUnbound(id: string): Promise<
    | { ok: true; deleted: boolean }
    | { ok: false; bound: number }
  > {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: lockRows } = await client.query<{ id: string }>(
        `SELECT id FROM my_bots WHERE id = $1 FOR UPDATE`, [id],
      );
      if (lockRows.length === 0) {
        await client.query('COMMIT');
        return { ok: true, deleted: false };
      }
      const { rows: countRows } = await client.query<{ count: string }>(
        `SELECT count(*)::text FROM tracked_channels WHERE bot_id = $1`, [id],
      );
      const bound = parseInt(countRows[0].count, 10);
      if (bound > 0) {
        await client.query('ROLLBACK');
        return { ok: false, bound };
      }
      await client.query(`DELETE FROM my_bots WHERE id = $1`, [id]);
      await client.query('COMMIT');
      return { ok: true, deleted: true };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
      throw err;
    } finally {
      client.release();
    }
  }
}
