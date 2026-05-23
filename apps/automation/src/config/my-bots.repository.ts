import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.tokens';

export interface MyBotRow {
  id:               string;
  botId:            string;
  username:         string | null;
  firstName:        string | null;
  platform:         string;
  tokenEnv:         string;
  active:           boolean;
  lastVerifiedAt:   Date | null;
  verifyError:      string | null;
  createdAt:        Date;
}

export interface MyBotInsertInput {
  botId:      string;
  username?:  string | null;
  firstName?: string | null;
  platform?:  string;
  tokenEnv:   string;
  active?:    boolean;
}

@Injectable()
export class MyBotsRepository {
  private readonly logger = new Logger(MyBotsRepository.name);

  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async list(): Promise<MyBotRow[]> {
    const r = await this.pool.query<any>(
      `SELECT * FROM my_bots ORDER BY created_at ASC`,
    );
    return r.rows.map((row) => this.toEntity(row));
  }

  async findById(id: string): Promise<MyBotRow | null> {
    const r = await this.pool.query<any>(
      `SELECT * FROM my_bots WHERE id = $1`, [id],
    );
    return r.rows[0] ? this.toEntity(r.rows[0]) : null;
  }

  async findByBotId(botId: string): Promise<MyBotRow | null> {
    const r = await this.pool.query<any>(
      `SELECT * FROM my_bots WHERE bot_id = $1`, [botId],
    );
    return r.rows[0] ? this.toEntity(r.rows[0]) : null;
  }

  async insert(input: MyBotInsertInput): Promise<string> {
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO my_bots
         (bot_id, username, first_name, platform, token_env, active)
       VALUES ($1, $2, $3, COALESCE($4, 'telegram'), $5, COALESCE($6, true))
       RETURNING id`,
      [
        input.botId,
        input.username ?? null,
        input.firstName ?? null,
        input.platform ?? null,
        input.tokenEnv,
        input.active ?? null,
      ],
    );
    return r.rows[0].id;
  }

  async markVerified(
    id: string,
    meta: { username?: string | null; firstName?: string | null },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE my_bots
       SET username         = COALESCE($2, username),
           first_name       = COALESCE($3, first_name),
           last_verified_at = now(),
           verify_error     = NULL
       WHERE id = $1`,
      [id, meta.username ?? null, meta.firstName ?? null],
    );
  }

  async markVerifyError(id: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE my_bots
       SET verify_error     = $2,
           last_verified_at = now()
       WHERE id = $1`,
      [id, error],
    );
  }

  async setActive(id: string, active: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE my_bots SET active = $2 WHERE id = $1`,
      [id, active],
    );
  }

  async delete(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM my_bots WHERE id = $1`, [id]);
  }

  async countChannelsBound(id: string): Promise<number> {
    const r = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tracked_channels WHERE bot_id = $1`,
      [id],
    );
    return parseInt(r.rows[0].count, 10);
  }

  private toEntity(r: any): MyBotRow {
    return {
      id:             r.id,
      botId:          r.bot_id,
      username:       r.username,
      firstName:      r.first_name,
      platform:       r.platform,
      tokenEnv:       r.token_env,
      active:         r.active,
      lastVerifiedAt: r.last_verified_at,
      verifyError:    r.verify_error,
      createdAt:      r.created_at,
    };
  }
}
