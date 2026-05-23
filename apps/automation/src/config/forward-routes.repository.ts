import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.tokens';

export interface ForwardRouteRow {
  id:               string;
  sourceChannelId:  string;
  targetChannelId:  string;
  topic:            string;
  description:      string;
  createdAt:        Date;
}

export interface ForwardRouteInsertInput {
  sourceChannelId: string;
  targetChannelId: string;
  topic:           string;
  description:     string;
}

@Injectable()
export class ForwardRoutesRepository {
  private readonly logger = new Logger(ForwardRoutesRepository.name);

  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async list(): Promise<ForwardRouteRow[]> {
    const r = await this.pool.query<any>(
      `SELECT * FROM forward_routes ORDER BY created_at ASC`,
    );
    return r.rows.map((row) => this.toEntity(row));
  }

  async insertIfMissing(input: ForwardRouteInsertInput): Promise<string | null> {
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO forward_routes
         (source_channel_id, target_channel_id, topic, description)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (source_channel_id, topic) DO NOTHING
       RETURNING id`,
      [
        input.sourceChannelId,
        input.targetChannelId,
        input.topic,
        input.description,
      ],
    );
    return r.rows[0]?.id ?? null;
  }

  private toEntity(r: any): ForwardRouteRow {
    return {
      id:               r.id,
      sourceChannelId:  r.source_channel_id,
      targetChannelId:  r.target_channel_id,
      topic:            r.topic,
      description:      r.description,
      createdAt:        r.created_at,
    };
  }
}
