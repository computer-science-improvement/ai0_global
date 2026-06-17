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
  last_verified_at:  Date | null;
  verify_error:      string | null;
  created_at:        Date;
}

export interface MyBotInsertInput {
  bot_id:    string;
  token_env: string;
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
      `INSERT INTO my_bots (bot_id, token_env, platform)
       VALUES ($1, $2, COALESCE($3, 'telegram'))
       RETURNING *`,
      [input.bot_id, input.token_env, input.platform ?? null],
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

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM my_bots WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
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
