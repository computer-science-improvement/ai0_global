import { normalizeImageUrl } from '../../media/image-url';
import { fittingPosters, posterFitsTopic, posterOf, type AiPoster } from '../../media/posters';
import { excerptOf, type AuditCard, type AuditContext, type AuditPost, type Finding, type IntegrityCheck } from '../types';

/**
 * Spec 037 FR-011 (T11), owner decision 2026-10-15: a post gets an image only when its source news had one.
 *   • `image_not_from_source` (error): a news post (news, giveaway, deal with a source) shows an image that is not an
 *     image of the source page the run read — its main image or (T17) one of the article's own images, so an album
 *     from the same article passes — or any image when that page had none (→ no media, format `text`). Without the
 *     page in `ctx.sources` (not read in this run, a feed item only, the export audit) it says nothing.
 *   • `poster_mismatch`: an `ai_posters` poster on a news post (error), or on a non-news post whose topic is not the
 *     poster's `use_for` — an error before publishing (`ctx.prePublish`: the executor can still fix it, and the message
 *     names the posters that fit, or says none does and the post goes without an image), a warning in the post audit of
 *     published specs (spec 067 FR-005). Needs only the post, so that audit sees it too.
 *
 * A post is news when it cites a web source, unless it is made from a library row (spec 067: the cited URL is the row's
 * page), the resource is evergreen / explainer / education, the post is a round-up or evergreen in its story, the slot
 * topic names a non-news kind (explainer, glossary, round-up, digest), or the post is a list of ≥ 3 items linking ≥ 3
 * sites (a round-up of resources, the 12.10 free courses).
 */

const NON_NEWS_KINDS = new Set(['evergreen', 'explainer', 'education']);
const NON_NEWS_TOPIC = /(?<![\p{L}])(?:поясн|глосар|словник|добірк|дайджест|підсумк|огляд|що таке|гайд|explainer|glossary|round-?up|digest|evergreen|guide|tutorial)/iu;

const normUrl = (u: string): string => u.trim().replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
const citedUrl = (post: AuditPost): string | undefined => post.citedSourceUrl ?? post.sourceUrl;

const hostOf = (u: string): string | null => {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
};

/** A list of ≥ 3 items whose links go to ≥ 3 different sites: a round-up of resources, not one news item. */
function linkRoundup(post: AuditPost): boolean {
  const items = post.text.split('\n').filter((l) => /^\s*(?:•|\d+\.)\s/.test(l)).length;
  const hosts = new Set(post.links.map((l) => hostOf(l.url)).filter(Boolean));
  return items >= 3 && hosts.size >= 3;
}

/** Whether the post is news for the media rules (see the file comment). */
export function isNewsPost(post: AuditPost, card?: AuditCard): boolean {
  if (post.fromLibrary) return false;
  const kind = typeof card?.style?.content_kind === 'string' ? card.style.content_kind.toLowerCase() : undefined;
  if (kind && NON_NEWS_KINDS.has(kind)) return false;
  if (post.story?.kind === 'roundup' || post.story?.kind === 'evergreen') return false;
  if (post.topic && NON_NEWS_TOPIC.test(post.topic)) return false;
  if (linkRoundup(post)) return false;
  const url = citedUrl(post);
  return !!url && /^https?:\/\//i.test(url);
}

const posterName = (p: AiPoster) => `«${p.title}»`;

/**
 * Spec 067 FR-005 / A5: what the code says about network posters for this post, whether or not it carries an image —
 * `news_no_poster` (a news post: only the source page's image or none), `poster_fits` (not news, and a poster's `use_for`
 * is the post's topic) or `none_fits` (not news, and no poster fits: the post goes without an image). The critic is told
 * this instead of judging the fit itself, and the owner's picture rules are not asked of it when no poster applies.
 */
export type PosterDecision = 'news_no_poster' | 'poster_fits' | 'none_fits';

export function posterDecisionOf(post: AuditPost, card?: AuditCard): PosterDecision {
  if (isNewsPost(post, card)) return 'news_no_poster';
  return fittingPosters({ head: [post.title, post.lead, post.topic], text: post.text }).length ? 'poster_fits' : 'none_fits';
}

export const mediaCheck: IntegrityCheck = {
  id: 'media',
  codes: ['image_not_from_source', 'poster_mismatch'],
  run: (post: AuditPost, ctx: AuditContext): Finding[] => {
    const images = post.imageUrls ?? [];
    if (!images.length) return [];
    const out: Finding[] = [];
    const news = isNewsPost(post, ctx.card);
    const posters = images.map((u) => ({ url: u, poster: posterOf(u) }));
    const onPosters = posters.filter((x) => x.poster).map((x) => x.poster!);

    if (onPosters.length && news) {
      out.push({
        code: 'poster_mismatch', level: 'error', excerpt: onPosters.map(posterName).join(', '),
        message: `постер мережі ${onPosters.map(posterName).join(', ')} на новині: новина йде лише із зображенням зі сторінки-джерела, а немає його — без зображення (format text)`,
      });
    } else if (onPosters.length) {
      const head = [post.title, post.lead, post.topic];
      const off = onPosters.filter((p) => !posterFitsTopic(p, { head, text: post.text }));
      if (off.length) {
        // The way out is named by code: the posters whose use_for is the topic, or text only when none is.
        const fits = fittingPosters({ head, text: post.text }).filter((p) => !onPosters.includes(p)).slice(0, 3);
        const way = fits.length
          ? `для цієї теми підходить: ${fits.map((p) => `${posterName(p)} (use_for: ${p.useFor})`).join('; ')} — ${fits.length === 1 ? 'візьми його' : 'обери один із них'} або пост без зображення (format text)`
          : 'жоден постер мережі не підходить до цієї теми — пост без зображення (format text)';
        out.push({
          code: 'poster_mismatch', level: ctx.prePublish ? 'error' : 'warning', excerpt: off.map(posterName).join(', '),
          message: `постер ${off.map((p) => `${posterName(p)} (use_for: ${p.useFor})`).join('; ')} не про тему поста «${excerptOf(post.title ?? post.lead ?? post.text, 80)}»: ${way}`,
        });
      }
    }

    if (!news) return out;
    const url = citedUrl(post)!;
    const page = (ctx.sources ?? []).find((s) => normUrl(s.url) === normUrl(url));
    if (!page || (page.image === undefined && page.images === undefined)) return out; // the page was not read in this run: never guess
    const pageImages = [...(page.image ? [page.image] : []), ...(page.images ?? [])];
    const allowed = new Set(pageImages.map(normalizeImageUrl));
    const foreign = posters.filter((x) => !x.poster && !allowed.has(normalizeImageUrl(x.url)));
    if (!foreign.length) return out;
    const main = page.image ?? pageImages[0];
    const more = allowed.size - 1;
    out.push({
      code: 'image_not_from_source', level: 'error', excerpt: excerptOf(foreign.map((x) => x.url).join(' '), 120),
      message: main
        ? `зображення не зі сторінки-джерела: ${foreign.map((x) => x.url).slice(0, 3).join(', ')} — для новини лише зображення джерела (головне ${main}${more > 0 ? ` або ще ${more} зі статті` : ''}) або пост без зображення (format text)`
        : `на сторінці-джерелі ${url} немає зображення — новина йде без media, format text (прибери ${foreign.map((x) => x.url).slice(0, 3).join(', ')})`,
    });
    return out;
  },
};
