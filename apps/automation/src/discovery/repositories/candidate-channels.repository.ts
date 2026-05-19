// apps/automation/src/discovery/repositories/candidate-channels.repository.ts
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';
import { CandidateChannelRow } from '../recommendations/recommendations.types';

export interface UpsertInput {
  source:      string;
  external_id: string;
  slug:        string;
  link:        string;
  title:       string;
  description: string | null;
  language:    string | null;
  themes:      string[];
  sex_ratio:   number | null;
  price_min:   number | null;
  price_max:   number | null;
  avatar_url:  string | null;
  raw_payload: unknown;
}

@Injectable()
export class CandidateChannelsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  /** Idempotent upsert. Returns true when this call inserted a new row, false on update. */
  async upsert(input: UpsertInput): Promise<{ inserted: boolean }> {
    const { rows } = await this.pool.query<{ inserted: boolean }>(
      `INSERT INTO candidate_channels
         (source, external_id, slug, link, title, description, language,
          themes, sex_ratio, price_min, price_max, avatar_url, raw_payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10,$11,$12,$13::jsonb)
       ON CONFLICT (source, external_id) DO UPDATE SET
         slug         = EXCLUDED.slug,
         link         = EXCLUDED.link,
         title        = EXCLUDED.title,
         description  = EXCLUDED.description,
         language     = EXCLUDED.language,
         themes       = EXCLUDED.themes,
         sex_ratio    = EXCLUDED.sex_ratio,
         price_min    = EXCLUDED.price_min,
         price_max    = EXCLUDED.price_max,
         avatar_url   = EXCLUDED.avatar_url,
         raw_payload  = EXCLUDED.raw_payload,
         last_seen_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [
        input.source, input.external_id, input.slug, input.link, input.title,
        input.description, input.language, input.themes, input.sex_ratio,
        input.price_min, input.price_max, input.avatar_url,
        JSON.stringify(input.raw_payload),
      ],
    );
    return { inserted: rows[0]?.inserted ?? false };
  }

  /**
   * Pre-filter for the recommendations service. Rows must share at least one
   * theme with the target AND fit the budget. Owned channels (passed in as a
   * lowercased username allowlist) are excluded. Hard cap of `limit` (default
   * 500) — final scoring + ranking happens in the service layer.
   */
  async candidatesForBudgetAndThemes(opts: {
    targetThemes:           string[];
    budget:                 number;
    excludeOwnedUsernames:  string[];
    limit?:                 number;
  }): Promise<Array<CandidateChannelRow & {
    estimated_subs_per_ad: number | null;
    roi_confidence:        string | null;
  }>> {
    const limit = opts.limit ?? 500;
    const exclude = opts.excludeOwnedUsernames.map(s => s.toLowerCase());
    const { rows } = await this.pool.query(
      `SELECT
         c.id, c.source, c.external_id, c.slug, c.link, c.title, c.description,
         c.language, c.themes, c.sex_ratio, c.price_min, c.price_max, c.avatar_url,
         r.estimated_subs_per_ad,
         r.confidence AS roi_confidence
       FROM candidate_channels c
       LEFT JOIN tracked_channels tc
              ON LOWER(tc.username) = LOWER(c.slug)
       LEFT JOIN tracked_roi_cache r
              ON r.channel_id = tc.id
       WHERE c.price_min IS NOT NULL
         AND c.price_min <= $1
         AND c.themes && $2::text[]
         AND (tc.username IS NULL OR NOT (LOWER(tc.username) = ANY($3::text[])))
       LIMIT $4`,
      [opts.budget, opts.targetThemes, exclude, limit],
    );
    return rows;
  }
}
