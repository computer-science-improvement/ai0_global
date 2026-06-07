// meta-content.ts — pure, dependency-free helpers for adapting a Telegram-style
// (HTML) post into a plain-text caption for Meta platforms. Safe to unit-test.

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
};

/** Strip Telegram/HTML markup to plain text, preserving anchor inner text and
 *  line breaks. `<br>` → newline, `</p>`/`</div>` → blank line; tags removed;
 *  HTML entities decoded; runs of 3+ newlines collapsed to 2. */
export function htmlToPlainText(html: string): string {
  if (!html) return '';
  let s = html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div)\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  for (const [ent, ch] of Object.entries(ENTITIES)) s = s.split(ent).join(ch);
  // numeric entities (&#1234;)
  s = s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)));
  return s.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
}

/** A single hashtag token from a free-form tag: alnum + underscore only. */
export function toHashtag(tag: string): string | null {
  const cleaned = tag.normalize('NFKC').replace(/[^\p{L}\p{N}_]+/gu, '');
  return cleaned ? `#${cleaned}` : null;
}

export interface CaptionOpts {
  maxLen:  number;   // hard character ceiling for the final caption
  maxTags: number;   // 0 = no hashtags appended
}

/** Build a plain-text caption: body (HTML stripped) + up to `maxTags` hashtags,
 *  truncated to `maxLen` (ellipsis added when truncated). */
export function buildCaption(text: string, tags: string[], opts: CaptionOpts): string {
  const body = htmlToPlainText(text);

  const hashtags = opts.maxTags > 0
    ? Array.from(new Set(tags.map(toHashtag).filter((t): t is string => !!t))).slice(0, opts.maxTags)
    : [];

  let caption = hashtags.length ? `${body}\n\n${hashtags.join(' ')}` : body;
  if (caption.length > opts.maxLen) {
    caption = caption.slice(0, Math.max(0, opts.maxLen - 1)).trimEnd() + '…';
  }
  return caption;
}
