import { NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import type { AgentsRepository } from '../agents/agents.repository';
import type { NetworkRepository } from '../network/network.repository';
import { telegramKeyOf } from '../agents/agent.types';
import type { TrackedLinks } from './tracked-links';

export class PromoService {
  constructor(private readonly d: {
    pool: Pick<Pool, 'query'>; agents: Pick<AgentsRepository, 'getByHandle' | 'get'>; network: Pick<NetworkRepository, 'groupOfChannel' | 'groupResources'>;
    links: Pick<TrackedLinks, 'click' | 'stats'>;
  }) {}

  click(code: string, v: { userAgent?: string | null; ip?: string | null } = {}) { return this.d.links.click(code, v); }

  async overview(handle: string) {
    const a = await this.d.agents.getByHandle(handle);
    if (!a) throw new NotFoundException({ error: 'agent_not_found' });
    const orch = a.parentId ? (await this.d.agents.get(a.parentId)) ?? a : a;
    const key = telegramKeyOf(orch);
    if (!key) return { pairs: [], slots: [], links: [] };
    const group = await this.d.network.groupOfChannel(key);
    const refs = group ? (await this.d.network.groupResources(group.id)).map((r) => r.ref) : [`telegram:${key}`];
    const { rows: pairs } = await this.d.pool.query(
      `SELECT source_ref, target_ref, last_promo_at, count_30d, relevance, relevance_at FROM promo_pairs
        WHERE source_ref = ANY($1::text[]) OR target_ref = ANY($1::text[]) ORDER BY last_promo_at DESC NULLS LAST`, [refs]);
    const { rows: slots } = await this.d.pool.query(
      `SELECT s.id, s.scheduled_at, s.status, s.error, s.promo, s.rendered_preview, d.outcome
         FROM editor_slots s LEFT JOIN agent_directives d ON d.id::text = s.promo->>'directive_id'
        WHERE s.channel_key = $1 AND s.promo IS NOT NULL ORDER BY s.scheduled_at DESC LIMIT 50`, [key]);
    return {
      pairs: pairs.map((p) => ({ sourceRef: p.source_ref, targetRef: p.target_ref, lastPromoAt: p.last_promo_at, count30d: p.count_30d, relevance: p.relevance })),
      slots: slots.map((s) => ({ id: s.id, at: s.scheduled_at, status: s.status, error: s.error, promo: s.promo, preview: s.rendered_preview, outcome: s.outcome })),
      links: await this.d.links.stats(refs),
    };
  }
}
