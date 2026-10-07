import { DATA_REF_RE, LIBRARY_REF_RE } from '../../data/data-refs';
import type { SeriesSource } from '../network/series';

/**
 * Series slot execution (spec 023 FR-005), pure parts: the source hints a series / pin source becomes, the
 * executor's series note, and the `series_source_mismatch` guard for a `required` source.
 */

/** Source hints of a series / pin source for the slot (`library:recipes`, `api:nasa_apod`, `feed:<ref>`…). */
export function sourceHints(src: SeriesSource | null | undefined): string[] {
  if (!src) return [];
  switch (src.kind) {
    case 'library': return [`library:${src.table}${src.category ? `/${src.category}` : ''}`];
    case 'api': return [`api:${src.source}`];
    case 'feed': return [`feed:${src.ref}`];
    case 'network_highlights': return [`network_highlights:${src.scope}`];
    default: return [];
  }
}

/** The dataset a PostSpec's library_ref names (data://<key>/<id> or library://<table>/<id>). */
export function refDataset(ref: string | null | undefined): string | null {
  if (!ref) return null;
  return ref.match(DATA_REF_RE)?.[1] ?? ref.match(LIBRARY_REF_RE)?.[1] ?? null;
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase().replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

const sameSite = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

/** API adapters whose items always link to one site (the others aggregate many sites). */
const API_HOSTS: Record<string, string[]> = {
  nasa_apod:     ['nasa.gov'],
  tmdb_trending: ['themoviedb.org'],
  on_this_day:   ['wikipedia.org'],
};

export interface SeriesForSlot {
  name:        string;
  brief:       string;
  format:      string;
  source:      SeriesSource | null;
  sourceMode:  'suggested' | 'required';
  locked:      boolean;
  /** An owner pin without a series (its brief and source are the pin's). */
  pin?:        boolean;
}

/**
 * `required` source guard: the post's library_ref dataset or source URL must match the series source.
 * Library → same dataset; feed → the feed's site; api → a source URL (on the adapter's site when it has
 * one); network highlights → a t.me link. Returns the reason, or null when the post is fine.
 */
export function seriesSourceMismatch(
  s: Pick<SeriesForSlot, 'name' | 'source' | 'sourceMode'>,
  refs: { libraryRef?: string | null; sourceUrl?: string | null },
  feeds: Array<{ id: string; ref: string }> = [],
): string | null {
  const src = s.source;
  if (s.sourceMode !== 'required' || !src || src.kind === 'free') return null;
  const host = hostOf(refs.sourceUrl);
  switch (src.kind) {
    case 'library': {
      const ds = refDataset(refs.libraryRef);
      return ds === src.table ? null : `серія «${s.name}» вимагає джерело library:${src.table}; у пості ${ds ? `library_ref з ${ds}` : 'немає library_ref'}`;
    }
    case 'feed': {
      const feed = feeds.find((f) => f.id === src.ref || f.ref === src.ref);
      const feedHost = hostOf(feed?.ref ?? src.ref);
      if (!host) return `серія «${s.name}» вимагає матеріал із фіду ${src.ref}; у пості немає source.url`;
      return !feedHost || sameSite(host, feedHost) ? null : `серія «${s.name}» вимагає матеріал із фіду ${src.ref}; джерело поста ${host}`;
    }
    case 'api': {
      if (!host) return `серія «${s.name}» вимагає джерело api:${src.source}; у пості немає source.url`;
      const hosts = API_HOSTS[src.source];
      return !hosts || hosts.some((h) => sameSite(host, h)) ? null : `серія «${s.name}» вимагає джерело api:${src.source}; джерело поста ${host}`;
    }
    case 'network_highlights':
      return host === 't.me' ? null : `серія «${s.name}» — дайджест мережі: джерело має бути посиланням t.me на пост мережі`;
    default:
      return null;
  }
}

/** The executor's series context (FR-005), in the agents' language. */
export function seriesNote(s: SeriesForSlot, label: (src: SeriesSource) => string): string {
  const src = s.source ? label(s.source) : null;
  return [
    s.pin
      ? `Це закріплений пост власника (pin, ${s.format}) — час і тему задав власник. Бриф: ${s.brief}`
      : `Це випуск серії «${s.name}» (${s.format}${s.locked ? ', серію задав власник' : ''}). Бриф серії: ${s.brief}`,
    src
      ? s.sourceMode === 'required'
        ? `Джерело серії обовʼязкове: ${src}. Пост має спиратися саме на нього (library_ref з цього датасету або source.url з нього) — інакше publish поверне series_source_mismatch. Якщо матеріалу там немає — skip_slot з причиною.`
        : `Рекомендоване джерело: ${src} (необовʼязкове). Можеш узяти інше джерело чи формат у межах плейбука — тоді коротко поясни чому в підсумку прогону (notes).`
      : 'Джерело серії не задане — обери його сам.',
  ].join('\n');
}
