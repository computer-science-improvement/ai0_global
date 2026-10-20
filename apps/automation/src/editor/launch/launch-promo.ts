import type { ChannelMode } from '../card';
import { MIN_RELEVANCE } from '../promo/promo-planner';

/**
 * Spec 052 FR-004: growth starts inside the network. After the first posts the launch picks up to 3 of our other
 * Telegram channels as promo sources (an agent in approval or live, not paused, healthy, relevant ≥ 3/5), ranked by
 * relevance and then subscribers. Pure: the service gathers the candidates, the 022 PromoPlanner schedules each one.
 */

export const MAX_PROMO_SOURCES = 3;

export interface PromoCandidate {
  key:       string;
  title:     string | null;
  subs:      number | null;
  /** The source's orchestrator (null = no agent runs it). */
  agentId:   string | null;
  mode:      ChannelMode;
  paused:    boolean;
  usable:    boolean;
  relevance: number;
  note:      string;
}

export interface PromoPick {
  picked: PromoCandidate[];
  /** Why none fits (English, the checklist). */
  note:   string | null;
}

export function pickPromoSources(cands: PromoCandidate[]): PromoPick {
  if (!cands.length) return { picked: [], note: 'No other own Telegram channel to promote from' };
  const why = (c: PromoCandidate): string | null =>
    !c.agentId ? 'no agent' : !['approve', 'live'].includes(c.mode) ? `in ${c.mode}` : c.paused ? 'paused'
      : !c.usable ? 'connection problem' : c.relevance < MIN_RELEVANCE ? `relevance ${c.relevance}/5` : null;
  const ok = cands.filter((c) => !why(c));
  const picked = [...ok].sort((a, b) => b.relevance - a.relevance || (b.subs ?? -1) - (a.subs ?? -1) || a.key.localeCompare(b.key)).slice(0, MAX_PROMO_SOURCES);
  if (picked.length) return { picked, note: null };
  const out = cands.map((c) => `${c.key} (${why(c)})`).slice(0, 6).join(', ');
  return { picked: [], note: `None of the network channels fits: ${out}` };
}
