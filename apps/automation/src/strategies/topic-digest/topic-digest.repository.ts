// Read-only query for the topic-digest strategy: our own already-published
// posts of the chosen source strategies (e.g. ai0-news + ua-news) in the
// window. Deliberately a RECAP of own content (retention loop, no dedup
// interaction with the single-post strategies), not a second RSS ingestion.
// The query is shared with get_network_highlights (src/common/digests, spec 023).
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';
import { digestPostsInWindow, type DigestPostRow } from '../../common/digests/digest-selection';

@Injectable()
export class TopicDigestRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async postsInWindow(
    windowHours: number,
    strategyTypes: string[],
    sourceChannels?: string[],
  ): Promise<DigestPostRow[]> {
    return digestPostsInWindow(this.pool, { windowHours, strategyTypes, channels: sourceChannels, order: 'oldest' });
  }
}
