import { excerptOf, readerText, type AuditPost, type AuditContext, type Finding, type IntegrityCheck } from '../types';

/**
 * Spec 037 FR-010 (T10): the content rules of an evergreen post (`story.kind = evergreen`, the fallback ladder's last
 * step). Such a post has no date anchor, so it must not read like news, and without a source it gives no specific
 * numbers (the writer's prompt says the same; T4 checks numbers against the sources the run read):
 *   • evergreen_dated (error): «щойно», «сьогодні», «новина», «вчора», «нещодавно», «прямо зараз», «цього тижня»;
 *   • evergreen_unsourced_number (warning): percentages, sums, millions / billions or 5+-digit numbers in a post with
 *     no source (no source line, link or button, and no page the run read).
 * Posts without the evergreen kind (every export) are not checked.
 */

const W = '(?<![\\p{L}\\p{N}\'’ʼ])';
const E = '(?![\\p{L}\\p{N}])';

/** News anchors an evergreen post may not use. */
const DATED_RE = new RegExp(
  `${W}(щойно|сьогодні|сьогоднішн\\p{L}*|новин(?:а|у|ою|і)|вчора|вчорашн\\p{L}*|нещодавно|прямо\\s+зараз|(?:на\\s+)?цьому\\s+тижні|цього\\s+тижня)${E}`, 'iu');

const NUM = '\\d+(?:[.,]\\d+)?';
/** Specific numbers that need a source: %, money, magnitudes, big plain numbers (years stay: 4 digits). */
const NUMBER_RES: RegExp[] = [
  new RegExp(`${NUM}\\s?(?:%|відсот\\p{L}*)`, 'iu'),
  new RegExp(`[$€₴£]\\s?\\d|${NUM}\\s?(?:\\$|€|₴|грн${E}|гривен\\p{L}*|долар\\p{L}*|євро${E}|USD${E})`, 'iu'),
  new RegExp(`${NUM}\\s?(?:млн${E}|млрд${E}|трлн${E}|тис\\.|тисяч\\p{L}*|мільйон\\p{L}*|мільярд\\p{L}*|трильйон\\p{L}*)`, 'iu'),
  /(?<![\d.,])\d{1,3}(?:[  ]\d{3})+(?![\d.,])|(?<![\d.,])\d{5,}(?![\d.,])/u,
];

function hasSource(post: AuditPost, ctx: AuditContext): boolean {
  return !!post.sourceUrl || post.links.length > 0 || post.buttons.some((b) => !!b.url) || (ctx.sources?.length ?? 0) > 0;
}

function around(text: string, m: RegExpExecArray): string {
  return excerptOf(text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 40));
}

export const evergreenCheck: IntegrityCheck = {
  id: 'evergreen',
  codes: ['evergreen_dated', 'evergreen_unsourced_number'],
  run: (post, ctx) => {
    if (post.story?.kind !== 'evergreen') return [];
    const text = readerText(post);
    const out: Finding[] = [];
    const dated = DATED_RE.exec(text);
    if (dated) {
      out.push({
        code: 'evergreen_dated', level: 'error', excerpt: around(text, dated),
        message: `вічнозелений пост без привʼязки до дати: «${dated[1]}» робить його новиною — прибери слово (пост має бути правдою і через місяць)`,
      });
    }
    if (!hasSource(post, ctx)) {
      for (const re of NUMBER_RES) {
        const m = re.exec(text);
        if (!m) continue;
        out.push({
          code: 'evergreen_unsourced_number', level: 'warning', excerpt: around(text, m),
          message: `конкретне число «${m[0].trim()}» без джерела: дай source.url сторінки, звідки воно, або скажи без цифр`,
        });
        break;
      }
    }
    return out;
  },
};
