import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.tokens';

export interface RoiCacheRow {
  channelId:           string;
  estimatedSubsPerAd:  number;
  confidence:          'low' | 'medium' | 'high';
  narrative:           string | null;
  risks:               string[] | null;
  inputs:              Record<string, unknown> | null;
  computedAt:          Date;
  source:              'heuristic' | 'claude';
}

export interface RoiCacheUpsert {
  channelId:           string;
  estimatedSubsPerAd:  number;
  confidence:          'low' | 'medium' | 'high';
  narrative?:          string | null;
  risks?:              string[] | null;
  inputs?:             Record<string, unknown> | null;
  source:              'heuristic' | 'claude';
}

@Injectable()
export class TrackedRoiCacheRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async get(channelId: string): Promise<RoiCacheRow | null> {
    const r = await this.pool.query<any>(`SELECT * FROM tracked_roi_cache WHERE channel_id = $1`, [channelId]);
    return r.rows[0] ? this.toEntity(r.rows[0]) : null;
  }

  async upsert(input: RoiCacheUpsert): Promise<void> {
    await this.pool.query(
      `INSERT INTO tracked_roi_cache
         (channel_id, estimated_subs_per_ad, confidence, narrative, risks, inputs, source, computed_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, now())
       ON CONFLICT (channel_id) DO UPDATE SET
         estimated_subs_per_ad = EXCLUDED.estimated_subs_per_ad,
         confidence            = EXCLUDED.confidence,
         narrative             = EXCLUDED.narrative,
         risks                 = EXCLUDED.risks,
         inputs                = EXCLUDED.inputs,
         source                = EXCLUDED.source,
         computed_at           = now()`,
      [
        input.channelId, input.estimatedSubsPerAd, input.confidence,
        input.narrative ?? null,
        input.risks ? JSON.stringify(input.risks) : null,
        input.inputs ? JSON.stringify(input.inputs) : null,
        input.source,
      ],
    );
  }

  private toEntity(r: any): RoiCacheRow {
    return {
      channelId:          r.channel_id,
      estimatedSubsPerAd: r.estimated_subs_per_ad,
      confidence:         r.confidence,
      narrative:          r.narrative,
      risks:              r.risks,
      inputs:             r.inputs,
      computedAt:         r.computed_at,
      source:             r.source,
    };
  }
}
