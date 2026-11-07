/**
 * Spec 091 FR-004: the recovery ladder. For a content slot that closed without a post it picks the cheapest rung not yet
 * tried today and builds the replacement spec. `nextRung` and `specFor` are pure; `RecoveryLadder` loads the facts with a few
 * $0 queries (no LLM) and implements `RungPlanner` (types.ts).
 *
 *   quality, critic            next_material → lighter_format → evergreen
 *   no_material, source_used   widen_live → other_series → evergreen
 *   source_unreachable         other_source → evergreen
 *
 * Evergreen is the last rung of every cause and is capped: EDITOR_EVERGREEN_PER_DAY, raised to SLO_EVERGREEN_DARK_MAX while the
 * channel is dark.
 */
import type { Pool } from 'pg';
import type { EditorCard } from '../card';
import type { SkipCause } from '../series-pause/skip-cause';
import type { LiveSpec } from '../live/live-slot';
import { evergreenCap, evergreenDarkMax, evergreenPerDay } from '../silent/evergreen';
import { localDate, zonedToUtc } from '../roles/time';
import { resourceKeys } from '../../data/data-refs';
import { catalogOverview } from '../tools/catalog-context';
import { normalizePlaybook } from '../network/series-edit';
import { PgSourceProbes } from '../sources/source-probes.repository';
import type { ClosedSlot, RungChoice, RungKind, RungPlanner, ReplacementSpec, SloSlotMark } from './types';

/** A probe older than this does not make a source "reachable" (FR-004). */
export const PROBE_FRESH_MS = 6 * 3600_000;
export const DEFAULT_WIDEN_MAX_HOURS = 48;

/** The rungs per cause, cheapest first. */
export const RUNGS_BY_CAUSE: Record<SkipCause, readonly RungKind[]> = {
  quality:            ['next_material', 'lighter_format', 'evergreen'],
  critic:             ['next_material', 'lighter_format', 'evergreen'],
  no_material:        ['widen_live', 'other_series', 'evergreen'],
  source_used:        ['widen_live', 'other_series', 'evergreen'],
  source_unreachable: ['other_source', 'evergreen'],
};

/** Lighter = cheaper to make and less to go wrong: text, then poll / quiz, then one image, then galleries, then video. */
const FORMAT_RANK: Record<string, number> = { text: 0, poll: 1, quiz: 1, photo: 2, image: 2, album: 3, carousel: 3, longread: 3, video: 4 };
export const formatRank = (f: string): number => FORMAT_RANK[f] ?? 5;

/** The lightest format of the mix that is lighter than `than` (null = nothing lighter). Ties go to the heavier weight. */
export function lighterFormat(formats: Record<string, number>, than: string): string | null {
  const c = Object.entries(formats).filter(([f, w]) => w > 0 && formatRank(f) < formatRank(than))
    .sort((a, b) => formatRank(a[0]) - formatRank(b[0]) || b[1] - a[1]);
  return c[0]?.[0] ?? null;
}

/** The lightest format the channel posts at all (for an evergreen post); `text` when the mix says nothing. */
export function lightestFormat(formats: Record<string, number>): string {
  const c = Object.entries(formats).filter(([, w]) => w > 0).sort((a, b) => formatRank(a[0]) - formatRank(b[0]) || b[1] - a[1]);
  return c[0]?.[0] ?? 'text';
}

export interface RunwaySeries { name: string; format: string; brief: string; dataset: string; unposted: number | null; repeats: boolean }
export interface OkSource { id: string; kind: string; ref: string }

/** Everything `nextRung` / `specFor` need, loaded once per choice. */
export interface LadderFacts {
  closed:         Pick<ClosedSlot, 'format' | 'topic' | 'topicMode' | 'live' | 'seriesName' | 'sourceHints'>;
  formats:        Record<string, number>;
  brief:          string;
  /** Other active, unpaused series of the channel whose dataset has runway (the closed slot's own series left out). */
  otherSeries:    RunwaySeries[];
  /** Card sources that passed the probe in the last 6 h (the source the closed slot used left out). */
  okSources:      OkSource[];
  /** Evergreen posts and runs of the channel's local day (written, planned by the controller, or tried by the ladder). */
  evergreenToday: number;
  /** The cap that applies now: EDITOR_EVERGREEN_PER_DAY, or SLO_EVERGREEN_DARK_MAX while dark (the larger). */
  evergreenCap:   number;
  widenMaxHours:  number;
}

/** Is this rung possible for these facts? */
export function rungAvailable(rung: RungKind, f: LadderFacts): boolean {
  switch (rung) {
    case 'next_material':  return true;
    case 'lighter_format': return lighterFormat(f.formats, f.closed.format) !== null;
    case 'widen_live':     return f.closed.topicMode === 'live' && !!f.closed.live && f.closed.live.max_age_hours < f.widenMaxHours;
    case 'other_series':   return f.otherSeries.length > 0;
    case 'other_source':   return f.okSources.length > 0;
    case 'evergreen':      return f.evergreenCap > 0 && f.evergreenToday < f.evergreenCap;
    default:               return false;
  }
}

/** The cheapest rung of the cause that was not tried today and is possible; null = none left (the channel is starved). */
export function nextRung(cause: SkipCause, tried: readonly RungKind[], facts: LadderFacts): RungKind | null {
  for (const r of RUNGS_BY_CAUSE[cause] ?? []) {
    if (tried.includes(r)) continue;
    if (rungAvailable(r, facts)) return r;
  }
  return null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The evergreen slot: the channel's own topic, no date anchor, marked in the angle so the writer sets `story.kind = evergreen`. */
export function evergreenReplacement(card: Pick<EditorCard, 'brief' | 'formats'>): ReplacementSpec {
  const brief = (card.brief ?? '').trim();
  return {
    format: lightestFormat(card.formats ?? {}),
    topic: `Вічнозелений пост у темі каналу${brief ? ` (${clip(brief, 160)})` : ''}: пояснення, гайд, глосарій або добірка`,
    angle: 'Без привʼязки до дати й новин: пост, що буде корисним і через місяць. Числа лише з джерела, яке ти прочитав. story: { kind: "evergreen", key: "тема-латиницею" }',
    sourceHints: [], seriesName: null, topicMode: 'fixed', live: null, ideaId: null,
  };
}

const NEXT_MATERIAL_NOTE = 'Попередній матеріал цього слота не підійшов: візьми НАСТУПНИЙ невикористаний рядок або матеріал тієї ж серії, не повторюй той самий.';

/** The replacement the rung asks for (pure). */
export function specFor(rung: RungKind, f: LadderFacts, card: Pick<EditorCard, 'brief' | 'formats'>): ReplacementSpec | null {
  const c = f.closed;
  const same: ReplacementSpec = {
    format: c.format, topic: c.topic, sourceHints: [...c.sourceHints], seriesName: c.seriesName ?? null,
    topicMode: c.topicMode, live: c.live ? { ...c.live } : null,
  };
  switch (rung) {
    case 'next_material':
      return { ...same, angle: NEXT_MATERIAL_NOTE };
    case 'lighter_format': {
      const fmt = lighterFormat(f.formats, c.format);
      return fmt ? { ...same, format: fmt, angle: `Важчий формат не вийшов — зроби цей пост у форматі ${fmt}.` } : null;
    }
    case 'widen_live': {
      if (!c.live) return null;
      const live: LiveSpec = { ...c.live, max_age_hours: f.widenMaxHours, origin: 'planner' };
      return { ...same, topicMode: 'live', live, angle: `Свіжого матеріалу за ${c.live.max_age_hours} год не було: шукай у вікні до ${f.widenMaxHours} год.` };
    }
    case 'other_series': {
      const s = [...f.otherSeries].sort((a, b) => Number(b.repeats) - Number(a.repeats) || (b.unposted ?? 0) - (a.unposted ?? 0))[0];
      if (!s) return null;
      return { format: s.format, topic: clip(s.brief, 200), angle: `Заміна слота: серія «${s.name}» має матеріал, бери наступний невикористаний.`, sourceHints: [], seriesName: s.name, topicMode: 'fixed', live: null, ideaId: null };
    }
    case 'other_source': {
      const s = f.okSources[0];
      if (!s) return null;
      if (c.topicMode === 'live' && c.live) {
        return { ...same, sourceHints: [], live: { ...c.live, sources: [s.id], origin: 'planner' }, angle: 'Попереднє джерело недоступне: це інше джерело каналу, яке відповідає.' };
      }
      return { ...same, sourceHints: [s.ref], angle: 'Попереднє джерело недоступне: бери матеріал з іншого джерела каналу (див. sourceHints).' };
    }
    case 'evergreen':
      return evergreenReplacement(card);
    default:
      return null;
  }
}

export const sloMarkFor = (closed: Pick<ClosedSlot, 'id' | 'slo'>, rung: RungKind, cause: SkipCause): SloSlotMark =>
  ({ replaces: closed.id, rung, cause, depth: (closed.slo?.depth ?? 0) + 1 });

/** What the class reads from Postgres (all $0). Swappable in tests. */
export interface LadderStore {
  seriesWithRunway(channelKey: string): Promise<RunwaySeries[]>;
  okSources(card: EditorCard, now: Date): Promise<OkSource[]>;
  evergreenToday(card: EditorCard, now: Date): Promise<number>;
  /** Today's `channel_slo` state is `dark`. */
  isDark(card: EditorCard, now: Date): Promise<boolean>;
}

export class PgLadderStore implements LadderStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  /** Active library series of the channel (not paused) whose dataset still has material to post. */
  async seriesWithRunway(channelKey: string): Promise<RunwaySeries[]> {
    const rr = resourceKeys(`telegram:${channelKey}`).resourceRef;
    const { rows } = await this.pool.query(
      `SELECT body FROM playbooks WHERE status = 'active' AND body->'series' @> jsonb_build_array(jsonb_build_object('resource_ref', $1::text))`, [rr]);
    const paused = await this.pool.query(`SELECT series_key FROM series_pauses WHERE resumed_at IS NULL AND lower(channel_key) = lower($1)`, [channelKey]);
    const pausedKeys = new Set(paused.rows.map((r: any) => String(r.series_key)));
    const mine = rows.flatMap((r: any) => normalizePlaybook(r.body).series ?? [])
      .filter((s) => s.active !== false && s.resource_ref === rr && s.source?.kind === 'library' && !pausedKeys.has(`series:${s.name}`));
    if (!mine.length) return [];
    const { datasets } = await catalogOverview(this.pool as Pool, { resource: rr });
    const byKey = new Map(datasets.map((d) => [d.dataset, d]));
    const out: RunwaySeries[] = [];
    for (const s of mine) {
      const d = byKey.get((s.source as { table: string }).table);
      if (!d) continue;
      const repeats = !!d.repeat;
      const unposted = d.unposted_here ?? null;
      if (!repeats && !(unposted !== null ? unposted > 0 : d.rows > 0)) continue;
      if (!repeats && d.runway_days != null && d.runway_days <= 0) continue;
      out.push({ name: s.name, format: s.format, brief: s.brief, dataset: d.dataset, unposted, repeats });
    }
    return out;
  }

  /** Feed and page sources of the card whose stored probe is ok and no older than 6 h. */
  async okSources(card: EditorCard, now: Date): Promise<OkSource[]> {
    const cands = (card.sources ?? []).filter((s) => s.kind === 'rss' || s.kind === 'url');
    if (!cands.length) return [];
    const probes = await new PgSourceProbes(this.pool).latest(cands.map((s) => s.ref));
    return cands.filter((s) => {
      const p = probes.get(s.ref);
      return !!p && p.ok && now.getTime() - new Date(p.checked_at).getTime() <= PROBE_FRESH_MS;
    }).map((s) => ({ id: s.id, kind: s.kind, ref: s.ref }));
  }

  /** The evergreen counter of the evergreen step (written evergreen posts and ladder runs) plus the controller's own evergreen slots. */
  async evergreenToday(card: EditorCard, now: Date): Promise<number> {
    const day = localDate(now, card.timezone);
    const from = zonedToUtc(day, '00:00', card.timezone);
    const to = new Date(from.getTime() + 86_400_000);
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM editor_slots s
        WHERE s.channel_key = $1 AND s.kind = 'content' AND s.resource_ref IS NULL
          AND s.scheduled_at >= $2 AND s.scheduled_at < $3
          AND ((s.status IN ('published','shadowed','awaiting_approval','approved') AND s.post_spec->'story'->>'kind' = 'evergreen')
            OR jsonb_path_exists(COALESCE(s.fallback, '{}'::jsonb), '$.steps[*] ? (@.step == "evergreen" && @.outcome != "unavailable")')
            OR (s.slo->>'rung' = 'evergreen' AND s.status NOT IN ('skipped','failed','expired')))`,
      [card.channelKey, from, to]);
    return Number(rows[0]?.n ?? 0);
  }

  async isDark(card: EditorCard, now: Date): Promise<boolean> {
    try {
      const { rows } = await this.pool.query(`SELECT state FROM channel_slo WHERE channel_key = $1 AND day = $2`, [card.channelKey, localDate(now, card.timezone)]);
      return rows[0]?.state === 'dark';
    } catch {
      return false;
    }
  }
}

export interface RecoveryLadderDeps {
  store: LadderStore;
  /** Settings, read live (SLO_WIDEN_MAX_HOURS, SLO_EVERGREEN_DARK_MAX, EDITOR_EVERGREEN_PER_DAY). */
  env:   (k: string) => string | undefined;
  /** Overrides the dark flag (the controller knows the state it just computed); default = today's channel_slo row. */
  isDark?: (card: EditorCard, now: Date) => Promise<boolean>;
  log?:  (m: string) => void;
}

export class RecoveryLadder implements RungPlanner {
  constructor(private readonly d: RecoveryLadderDeps) {}

  private widenMax(): number {
    const n = Number(this.d.env('SLO_WIDEN_MAX_HOURS'));
    return Number.isFinite(n) && n >= 6 ? Math.min(168, Math.floor(n)) : DEFAULT_WIDEN_MAX_HOURS;
  }

  private async dark(card: EditorCard, now: Date): Promise<boolean> {
    return (this.d.isDark ? this.d.isDark(card, now) : this.d.store.isDark(card, now)).catch(() => false);
  }

  /** The evergreen cap now and how much of it is used (FR-004: raised while the channel is dark). */
  async evergreenRoom(card: EditorCard, now: Date): Promise<{ used: number; cap: number; dark: boolean }> {
    const dark = await this.dark(card, now);
    const cap = evergreenCap(evergreenPerDay(this.d.env), evergreenDarkMax(this.d.env), dark);
    const used = await this.d.store.evergreenToday(card, now).catch(() => cap);
    return { used, cap, dark };
  }

  /** The evergreen spec for the channel (dark recovery inserts it directly). */
  evergreenSpec(card: EditorCard): ReplacementSpec { return evergreenReplacement(card); }

  async loadFacts(card: EditorCard, closed: ClosedSlot, cause: SkipCause, now: Date): Promise<LadderFacts> {
    const rungs = RUNGS_BY_CAUSE[cause] ?? [];
    const need = (r: RungKind) => rungs.includes(r);
    const noSeries: RunwaySeries[] = [];
    const noSources: OkSource[] = [];
    const series: RunwaySeries[] = need('other_series')
      ? await this.d.store.seriesWithRunway(card.channelKey).catch((e) => { this.d.log?.(`ladder: series runway not read: ${e?.message ?? e}`); return noSeries; }) : noSeries;
    const sources: OkSource[] = need('other_source') ? await this.d.store.okSources(card, now).catch(() => noSources) : noSources;
    const room = await this.evergreenRoom(card, now);
    const usedRefs = new Set([...(closed.live?.sources ?? []), ...closed.sourceHints].map((x) => x.toLowerCase()));
    return {
      closed, formats: card.formats ?? {}, brief: card.brief ?? '',
      otherSeries: series.filter((s) => s.name !== closed.seriesName),
      okSources: sources.filter((s) => !usedRefs.has(s.id.toLowerCase()) && !usedRefs.has(`feed:${s.id}`.toLowerCase()) && !usedRefs.has(s.ref.toLowerCase())),
      evergreenToday: room.used, evergreenCap: room.cap, widenMaxHours: this.widenMax(),
    };
  }

  async choose(card: EditorCard, closed: ClosedSlot, cause: SkipCause, tried: readonly RungKind[], now: Date): Promise<RungChoice | null> {
    const facts = await this.loadFacts(card, closed, cause, now);
    // A rung whose spec cannot be built is as good as tried: take the next one.
    const skip: RungKind[] = [...tried];
    for (;;) {
      const rung = nextRung(cause, skip, facts);
      if (!rung) return null;
      const spec = specFor(rung, facts, card);
      if (spec) return { rung, spec };
      skip.push(rung);
    }
  }
}
