import { z } from 'zod';
import type { CardSource } from '../card';
import type { SeriesSource } from '../network/series';
import { localTimeLabel } from '../roles/time';

/**
 * Live news slots (spec 034 FR-010). A `fixed` slot carries the topic the planner chose; a `live` slot
 * carries a source and a brief, and the executor picks the freshest unposted item of that source at
 * slot time. Pure helpers shared by both plan validators, the repository, the prompts and the news watch.
 */

export const TOPIC_MODES = ['fixed', 'live'] as const;
export type TopicMode = typeof TOPIC_MODES[number];

/** How old an item a live news slot may take by default (hours). */
export const LIVE_DEFAULT_MAX_AGE_HOURS = 6;
/** The skip code of a live slot with nothing fresh. */
export const NO_FRESH_ITEM = 'no_fresh_item';

export interface LiveItemRef {
  url:           string;
  title:         string;
  published_at?: string | null;
}

/** editor_slots.live_spec. */
export interface LiveSpec {
  /** Feed URLs, card source ids, `feed:<id>`, `api:<name>`. */
  sources:       string[];
  brief:         string;
  max_age_hours: number;
  origin:        'planner' | 'news_watch' | 'pin';
  /** news_watch: the item the slot was added for. */
  item?:         LiveItemRef | null;
}

/** The plan-input fields of a live slot (both validators). Ukrainian descriptions: the planner reads them. */
export const LIVE_SLOT_FIELDS = {
  topic_mode:    z.enum(TOPIC_MODES).optional()
    .describe('fixed — тема відома зараз (topic обовʼязковий); live — тему обере виконавець у час слота з найсвіжішого матеріалу джерела (новини). Без topic → live'),
  source:        z.array(z.string().min(2).max(300)).max(5).optional()
    .describe('live: фіди (URL або id джерела картки), feed:<id> або api:<назва>; без нього — джерело серії або RSS картки'),
  brief:         z.string().min(5).max(400).optional().describe('live: що шукати і як подати (замість конкретної теми)'),
  max_age_hours: z.number().int().min(1).max(72).optional().describe(`live: найстаріший допустимий матеріал, год (типово ${LIVE_DEFAULT_MAX_AGE_HOURS})`),
};

export interface LiveSlotInputLike {
  topic?:         string;
  topic_mode?:    TopicMode;
  source?:        string[];
  brief?:         string;
  max_age_hours?: number;
  angle?:         string;
}

export type ResolvedTopic =
  | { ok: true; topic: string; topicMode: TopicMode; live: LiveSpec | null }
  | { ok: false; error: string };

/** Sources a series source gives a live slot (library and free series have none). */
export function seriesLiveSources(src: SeriesSource | null | undefined): string[] {
  if (!src) return [];
  if (src.kind === 'feed') return [`feed:${src.ref}`];
  if (src.kind === 'api') return [`api:${src.source}`];
  return [];
}

/** The card's own feeds (rss sources), as ids — the last fallback of a live slot. */
export function cardFeedIds(sources: CardSource[] | undefined): string[] {
  return (sources ?? []).filter((s) => s.kind === 'rss').map((s) => s.id);
}

function hostOf(u: string): string | null {
  try {
    const x = new URL(u);
    return /^https?:$/.test(x.protocol) ? x.hostname.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

/** A short human name of a source: a feed's site, `api:<name>` → name, `feed:<id>` → id. */
export function sourceName(src: string): string {
  const s = src.trim();
  return hostOf(s) ?? s.replace(/^(feed|rss|api):/i, '');
}

/** The stored topic of a live slot: «Свіжа новина з <source>». */
export function liveTopicLabel(sources: string[], item?: LiveItemRef | null): string {
  if (item?.title) return `Свіжа новина: ${item.title}`.slice(0, 300);
  const names = [...new Set(sources.map(sourceName))];
  if (!names.length) return 'Свіжа новина';
  return `Свіжа новина з ${names[0]}${names.length > 1 ? ` (+${names.length - 1})` : ''}`.slice(0, 300);
}

/**
 * The topic of a plan slot: `fixed` needs a topic; `live` needs a source (its own, its series', or the
 * card's feeds). Default mode: `live` when the slot has no topic or realises a series with a feed source.
 */
export function resolveSlotTopic(
  s: LiveSlotInputLike,
  o: { label: string; seriesSource?: SeriesSource | null; cardFeeds?: string[] },
): ResolvedTopic {
  const feedSeries = o.seriesSource?.kind === 'feed';
  const mode: TopicMode = s.topic_mode ?? (!s.topic?.trim() || feedSeries ? 'live' : 'fixed');
  if (mode === 'fixed') {
    const topic = s.topic?.trim() ?? '';
    if (topic.length < 5) return { ok: false, error: `${o.label}: потрібна конкретна тема (topic, ≥ 5 символів) або topic_mode "live" з джерелом` };
    return { ok: true, topic, topicMode: 'fixed', live: null };
  }
  const own = (s.source ?? []).map((x) => x.trim()).filter(Boolean);
  const bad = own.filter((x) => /^https?:/i.test(x) && !hostOf(x));
  if (bad.length) return { ok: false, error: `${o.label}: джерело live-слота має бути URL фіду, id джерела картки, feed:<id> або api:<назва> (${bad.join(', ')})` };
  if (own.some((x) => /^library:/i.test(x)) || (!own.length && o.seriesSource?.kind === 'library')) {
    return { ok: false, error: `${o.label}: live-слот бере свіже з фіду чи API, а не з бібліотеки — зроби слот fixed` };
  }
  const sources = own.length ? own : seriesLiveSources(o.seriesSource).length ? seriesLiveSources(o.seriesSource) : (o.cardFeeds ?? []);
  if (!sources.length) return { ok: false, error: `${o.label}: live-слот без джерела — вкажи source (URL фіду, id джерела картки або api:<назва>)` };
  const brief = (s.brief ?? s.topic ?? '').trim() || 'Найважливіший свіжий матеріал джерела для аудиторії ресурсу';
  return {
    ok: true, topicMode: 'live', topic: liveTopicLabel(sources),
    live: { sources: sources.slice(0, 5), brief: brief.slice(0, 400), max_age_hours: s.max_age_hours ?? LIVE_DEFAULT_MAX_AGE_HOURS, origin: 'planner' },
  };
}

/** One candidate the code found for a live slot (feed item). */
export interface LiveCandidate {
  title:     string;
  url:       string;
  ageHours:  number;
  snippet?:  string | null;
  feed?:     string | null;
}

/** What the code-side scan of a live slot's feeds found (null fields when nothing was read). */
export interface LiveScan {
  items:         LiveCandidate[];
  feedsRead:     number;
  feedsFailed:   number;
  /** api:… sources the code does not read — the agent reads them with fetch_api. */
  otherSources:  string[];
  dropped:       { old: number; undated: number; posted: number; similar: number };
}

/** Why a scan found nothing (Ukrainian, for the slot error and the trace). */
export function noFreshReason(spec: Pick<LiveSpec, 'sources' | 'max_age_hours'>, scan: LiveScan): string {
  const d = scan.dropped;
  return `${NO_FRESH_ITEM}: no item ≤ ${spec.max_age_hours} h in ${spec.sources.map(sourceName).join(', ')} that was not posted `
    + `(${scan.feedsRead} feed(s) read${scan.feedsFailed ? `, ${scan.feedsFailed} failed` : ''}; ${d.old} old, ${d.undated} undated, ${d.posted} posted, ${d.similar} similar)`;
}

/**
 * The executor's lines for a live slot (both the Telegram and the platform executor): no fixed topic,
 * where to look, the freshness rule, the dedup, and the skip code. `scan` lists what the code found.
 */
export function liveSlotLines(spec: LiveSpec, o: { tz: string; scan?: LiveScan | null }): string[] {
  const feeds = spec.sources.filter((s) => !/^api:/i.test(s));
  const apis = spec.sources.filter((s) => /^api:/i.test(s));
  const lines = [
    'Це live-слот: тема НЕ задана заздалегідь — обери її зараз із найсвіжішого матеріалу джерела.',
    `Бриф: ${spec.brief}`,
    `Джерела: ${spec.sources.join('; ')}.`,
    feeds.length
      ? `Фіди читай fetch_feed з since_hours: ${spec.max_age_hours} і exclude_posted: true — код відкине старше ${spec.max_age_hours} год, уже опубліковане на ресурсі й схоже на пости останніх 7 днів.`
      : '',
    apis.length ? `API (${apis.join(', ')}) — fetch_api; бери лише записи не старші за ${spec.max_age_hours} год.` : '',
    'Обери один найважливіший для аудиторії матеріал, прочитай першоджерело (web_fetch) і пиши; source.url — посилання саме на цей матеріал.',
    `Якщо свіжого матеріалу немає — skip_slot з code "${NO_FRESH_ITEM}" і причиною. Старе чи повторне не публікуй.`,
  ];
  if (spec.item?.url) {
    const at = spec.item.published_at ? new Date(spec.item.published_at) : null;
    lines.push(`Код додав цей слот під свіжий матеріал: «${spec.item.title}» ${spec.item.url}${at && !Number.isNaN(at.getTime()) ? ` (опубліковано ${localTimeLabel(at, o.tz)})` : ''}. Пиши про нього, якщо він досі актуальний; зʼявилося важливіше свіже — бери його.`);
  }
  if (o.scan?.items.length) {
    lines.push('Свіжі неопубліковані матеріали, які код уже знайшов (від найсвіжішого):');
    for (const [i, c] of o.scan.items.slice(0, 5).entries()) {
      lines.push(`${i + 1}. «${c.title}» — ${c.url} (${c.ageHours.toFixed(1)} год тому)`);
    }
  }
  return lines.filter(Boolean);
}
