/**
 * Spec 091: placeholder `RungPlanner` and `DarkRecovery` so the controller core compiles and runs on its own. The real
 * implementations (`recovery-ladder.ts`, `dark-recovery.ts`) replace these in `editor.module.ts`.
 *
 *  - `StubRungPlanner`: one rung only, an evergreen slot in the channel's own topic, once a day per channel (`tried` says so).
 *  - `StubDarkRecovery`: clears the planner tries, runs the planner once with the dark context, and when no slot is planned
 *    for today inserts one evergreen slot (FR-005 steps 1-3 in their simplest form).
 */
import type { Pool } from 'pg';
import type { EditorCard } from '../card';
import { localDate, zonedToUtc } from '../roles/time';
import type { ClosedSlot, DarkContext, DarkRecovery, DarkRecoveryResult, ReplacementSpec, RungChoice, RungPlanner, SlotInserter } from './types';
import type { SkipCause } from '../series-pause/skip-cause';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The format an evergreen slot takes: text when the card allows it, else the heaviest allowed one. */
export function evergreenFormat(card: Pick<EditorCard, 'formats'>): string | null {
  if (Number(card.formats.text ?? 0) > 0) return 'text';
  const allowed = Object.entries(card.formats).filter(([, w]) => Number(w) > 0).sort((a, b) => b[1] - a[1]);
  return allowed[0]?.[0] ?? null;
}

export function evergreenSpec(card: Pick<EditorCard, 'formats' | 'brief'>): ReplacementSpec | null {
  const format = evergreenFormat(card);
  if (!format) return null;
  const brief = (card.brief ?? '').trim();
  return {
    format, topicMode: 'fixed',
    topic: `Вічнозелений пост у темі каналу${brief ? ` (${clip(brief, 160)})` : ''}: пояснення, гайд, глосарій або добірка`,
    angle: 'Без привʼязки до дати чи новини; корисне й через місяць.',
  };
}

export class StubRungPlanner implements RungPlanner {
  async choose(card: EditorCard, _closed: ClosedSlot, _cause: SkipCause, tried: readonly string[]): Promise<RungChoice | null> {
    if (tried.includes('evergreen')) return null;
    const spec = evergreenSpec(card);
    return spec ? { rung: 'evergreen', spec } : null;
  }
}

export interface StubDarkRecoveryDeps {
  pool: Pick<Pool, 'query'>;
  inserter: SlotInserter;
  /** `EditorScheduler.resetPlannerTries`. */
  resetTries: (channelKey: string, now: Date) => void;
  /** `EditorScheduler.runPlannerNow`. */
  runPlanner: (card: EditorCard, extraContext: string) => Promise<unknown>;
}

export class StubDarkRecovery implements DarkRecovery {
  constructor(private readonly d: StubDarkRecoveryDeps) {}

  async recover(card: EditorCard, ctx: DarkContext, now: Date): Promise<DarkRecoveryResult> {
    this.d.resetTries(card.channelKey, now);
    const extra = [
      `Канал без постів з ${ctx.darkSince.toISOString().slice(0, 16).replace('T', ' ')} UTC. Заплануй щонайменше ${ctx.target} постів на сьогодні; віддай перевагу форматам і джерелам, що публікувалися за останні 14 днів.`,
      ctx.lastSkips.length ? `Останні причини пропусків:\n${ctx.lastSkips.map((s) => `- ${s}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');
    let error: string | null = null;
    try { await this.d.runPlanner(card, extra); } catch (err: any) { error = String(err?.message ?? err).slice(0, 200); }
    const day = localDate(now, card.timezone);
    const from = zonedToUtc(day, '00:00', card.timezone);
    const { rows } = await this.d.pool.query(
      `SELECT count(*)::int AS n FROM editor_slots WHERE channel_key = $1 AND kind = 'content' AND resource_ref IS NULL
          AND status IN ('planned','running','awaiting_approval','approved') AND scheduled_at >= $2 AND scheduled_at < $3`,
      [card.channelKey, now, new Date(from.getTime() + 86_400_000)]);
    const planned = Number(rows[0]?.n ?? 0);
    if (planned > 0) return { planned, evergreenSlotId: null, summary: `planner run planned ${planned} slot(s) for the rest of today` };
    const spec = evergreenSpec(card);
    const id = spec ? await this.d.inserter.insert(card, spec, { replaces: null, rung: 'evergreen', cause: null, depth: 1 }, now) : null;
    return {
      planned: 0, evergreenSlotId: id,
      summary: `${error ? `planner run failed (${error})` : 'planner run planned nothing'}; ${id ? 'one evergreen slot inserted' : 'no room for an evergreen slot'}`,
    };
  }
}
