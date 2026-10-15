import { isSiteIndexUrl, sourceHost, sourceTier } from '../../../../data/source-tier';
import { groundNumbers, postNumbers, statisticalPercents, type PostNumber } from '../../grounding';
import { factConflicts } from '../../fact-conflict';
import { bodyText, excerptOf, type AuditContext, type AuditPost, type AuditSource, type Finding, type IntegrityCheck } from '../types';

/**
 * Spec 037 FR-004 (T4): facts and sources.
 *   • `number_not_in_sources` (warning): a claim of the post (price, %, count with a unit, date) found in none of the
 *     texts the run read (`ctx.sources[].text`). Without any source text — the export audit, a lint call outside a
 *     run — it says nothing, except about a statistical percentage in a post that cites no source at all («90% задач»).
 *   • `source_is_homepage` (error): `source.url` is a site root or a section index.
 *   • `low_tier_claim` (warning): numbers from a low-tier source ("N fun facts" lists, content farms).
 *   • `source_aggregator` (warning): the source is an aggregator whose page links the primary source.
 *   • `fact_conflict` (warning): a price, character or deadline told differently by an earlier post (fact-conflict.ts);
 *     before publishing the story guard runs it on the story registry's history.
 */

const normUrl = (u: string): string => u.trim().replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();

/** The post's own source URL (the `→` line, or the spec's source whatever the link style). */
export const citedUrl = (post: AuditPost): string | undefined => post.citedSourceUrl ?? post.sourceUrl;

const list = (ns: PostNumber[]): string => [...new Set(ns.map((n) => `«${n.text}»`))].slice(0, 8).join(', ');
const dates = (post: AuditPost) => ({ publishedAt: post.publishedAt, timezone: post.timezone || 'Europe/Kyiv' });

function readOf(ctx: AuditContext, url: string | undefined): AuditSource | undefined {
  if (!url) return undefined;
  const key = normUrl(url);
  return (ctx.sources ?? []).find((s) => normUrl(s.url) === key);
}

export const groundingCheck: IntegrityCheck = {
  id: 'grounding',
  codes: ['number_not_in_sources'],
  run: (post, ctx) => {
    const text = bodyText(post);
    const g = groundNumbers(text, (ctx.sources ?? []).map((s) => ({ url: s.url, text: s.text, title: s.title })), dates(post));
    if (g.checked) {
      if (!g.missing.length) return [];
      return [{
        code: 'number_not_in_sources', level: 'warning', excerpt: excerptOf(list(g.missing), 120),
        message: `чисел немає на сторінках, які ти прочитав: ${list(g.missing)} — візьми їх зі сторінки джерела (критик бачить уривки навколо цих чисел) або прибери`,
      }];
    }
    // No source text: only a statistical percentage in a post that cites nothing at all is an unsourced claim.
    if (citedUrl(post) || post.links.length) return [];
    const stats = statisticalPercents(text, dates(post));
    if (!stats.length) return [];
    return [{
      code: 'number_not_in_sources', level: 'warning', excerpt: excerptOf(list(stats), 120),
      message: `у пості немає джерела для ${list(stats)} — дай посилання на сторінку з цим числом або прибери його`,
    }];
  },
};

export const homepageCheck: IntegrityCheck = {
  id: 'source-homepage',
  codes: ['source_is_homepage'],
  run: (post) => {
    const url = citedUrl(post);
    if (!url || !isSiteIndexUrl(url)) return [];
    return [{
      code: 'source_is_homepage', level: 'error', excerpt: url,
      message: `джерело — головна сторінка чи розділ сайту (${url}): дай посилання на саму статтю чи сторінку товару, гри`,
    }];
  },
};

export const sourceTierCheck: IntegrityCheck = {
  id: 'source-tier',
  codes: ['low_tier_claim', 'source_aggregator'],
  run: (post, ctx) => {
    const url = citedUrl(post);
    const page = readOf(ctx, url);
    const tier = url ? sourceTier(url, page?.title) : null;
    const text = bodyText(post);
    const out: Finding[] = [];
    const numbers = postNumbers(text, dates(post));
    if (tier === 'low' && numbers.length) {
      out.push({
        code: 'low_tier_claim', level: 'warning' as const, excerpt: excerptOf(list(numbers), 120),
        message: `числа зі слабкого джерела (${sourceHost(url)} — список «цікавих фактів» чи контент-ферма): ${list(numbers)} — підтверди надійним джерелом або прибери`,
      });
    } else if (numbers.length && ctx.sources?.some((s) => s.text)) {
      // A number found only on low-tier pages of the run is as weak as a low-tier source.
      const g = groundNumbers(text, ctx.sources.map((s) => ({ url: s.url, text: s.text })), dates(post));
      const weak = g.found.filter((f) => f.urls.every((u) => sourceTier(u, readOf(ctx, u)?.title) === 'low')).map((f) => f.number);
      if (weak.length) {
        out.push({
          code: 'low_tier_claim', level: 'warning' as const, excerpt: excerptOf(list(weak), 120),
          message: `ці числа є лише на слабких сторінках («цікаві факти», контент-ферми): ${list(weak)} — підтверди надійним джерелом або прибери`,
        });
      }
    }
    if (tier === 'aggregator' && page?.primaryLinks?.length) {
      out.push({
        code: 'source_aggregator', level: 'warning' as const, excerpt: page.primaryLinks[0],
        message: `${sourceHost(url)} — агрегатор, а сторінка посилається на першоджерело: ${page.primaryLinks.slice(0, 3).join(', ')} — візьми першоджерело (web_fetch) і дай його в source`,
      });
    }
    return out;
  },
};

export const factConflictCheck: IntegrityCheck = {
  id: 'fact-conflict',
  codes: ['fact_conflict'],
  run: (post, ctx) => factConflicts(post, ctx.previous ?? []),
  // Before publishing the story guard runs it on the registry's 14 days (published, waiting, approved posts):
  // lintPost's `previous` (the last 20 posts) is shorter than a story.
  lintEnforced: true,
};

export const SOURCE_CHECKS: IntegrityCheck[] = [groundingCheck, homepageCheck, sourceTierCheck, factConflictCheck];
