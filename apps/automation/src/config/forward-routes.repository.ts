// apps/automation/src/config/forward-routes.repository.ts
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

export interface ForwardRouteRow {
  id:                 string;
  source_channel_id:  string;
  target_channel_id:  string;
  topic:              string;
  description:        string;
}

export interface ForwardRouteInsertInput {
  source_channel_id: string;
  target_channel_id: string;
  topic:             string;
  description:       string;
}

@Injectable()
export class ForwardRoutesRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async list(): Promise<ForwardRouteRow[]> {
    const { rows } = await this.pool.query<ForwardRouteRow>(
      `SELECT id, source_channel_id, target_channel_id, topic, description
       FROM forward_routes
       ORDER BY topic`,
    );
    return rows;
  }

  async insertIfMissing(input: ForwardRouteInsertInput): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO forward_routes (source_channel_id, target_channel_id, topic, description)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (source_channel_id, topic) DO NOTHING`,
      [input.source_channel_id, input.target_channel_id, input.topic, input.description],
    );
    return (rowCount ?? 0) > 0;
  }
}
