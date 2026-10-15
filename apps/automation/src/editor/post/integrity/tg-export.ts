import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import type { AuditMediaKind, AuditPoll, AuditPost } from './types';

/**
 * Spec 037 FR-001: a Telegram Desktop HTML export (`messages.html`, `messages2.html`, … of one chat) → `AuditPost[]`.
 *
 * What it reads: the channel title from the page header; each `.message.default` with its id, the instant from the
 * `title` of `.date` (`07.10.2026 14:02:41 UTC+02:00`, offset kept), the text (`<br>` → line break, a leading
 * `<strong>`/`<b>` → `lead`, links, hashtags, the `→ Source` line), rich messages (`.text.rich_message`: paragraphs,
 * headings, lists, quotes, footers, media items), inline buttons, media type/count and polls (question, options,
 * anonymous / quiz). Service messages (date separators, pins) are skipped. A message with only media right after a
 * post is a part of the same album: its media is added to that post instead of becoming an empty post.
 *
 * Offline and pure apart from reading the files; no images or raw HTML leave this module.
 */

const UK_LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch',
  ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', ʼ: '', '\'': '', ы: 'y', э: 'e', ё: 'io', ъ: '',
};

/** «AI Шукає Новини | DEV» → `ai-shukaie-novyny-dev` (ids of the fixture and the report). */
export function channelSlug(title: string): string {
  return [...title.toLowerCase()].map((c) => UK_LATIN[c] ?? c).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'channel';
}

/** `07.10.2026 14:02:41 UTC+02:00` → `2026-10-07T14:02:41+02:00`; null when the format is unknown. */
export function exportDateToIso(title: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})(?: UTC([+-]\d{2}):?(\d{2}))?/.exec(title.trim());
  if (!m) return null;
  const [, d, mo, y, h, mi, s, oh, om] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${oh ? `${oh}:${om}` : 'Z'}`;
}

type Node = cheerio.AnyNode;
/** The text of a text node (cheerio rc.12 does not re-export domhandler's Text). */
const textOf = (n: Node): string => (n as unknown as { data: string }).data;
type $T = cheerio.CheerioAPI;

/** Collects the plain text of inline HTML: line breaks, links, hashtags, the `→` source link. */
class TextSink {
  out = '';
  links: { text: string; url: string }[] = [];
  hashtags: string[] = [];
  sourceUrl?: string;

  private push(s: string) { this.out += s; }

  inline($: $T, nodes: Node[]): void {
    for (const n of nodes) {
      if (n.type === 'text') { this.push(textOf(n).replace(/[\t\n\r ]+/g, ' ')); continue; }
      if (n.type !== 'tag') continue;
      const el = n as cheerio.Element;
      const tag = el.tagName.toLowerCase();
      if (tag === 'br') { this.push('\n'); continue; }
      if (tag === 'a') {
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        const onclick = $(el).attr('onclick') ?? '';
        if (/ShowHashtag/.test(onclick) || (text.startsWith('#') && !$(el).attr('href'))) {
          this.hashtags.push(text.replace(/^#/, ''));
          this.push(text);
          continue;
        }
        const url = $(el).attr('href') ?? '';
        const line = this.out.slice(this.out.lastIndexOf('\n') + 1).trim();
        if (url && /^https?:/i.test(url)) {
          this.links.push({ text, url });
          if (line === '→' && !this.sourceUrl) this.sourceUrl = url;
        }
        this.push(text);
        continue;
      }
      this.inline($, el.children as Node[]);
    }
  }

  /** Paragraph break: at most one blank line between paragraphs. */
  para(): void {
    this.out = this.out.replace(/[ \t]+$/g, '');
    if (this.out && !this.out.endsWith('\n\n')) this.out += this.out.endsWith('\n') ? '\n' : '\n\n';
  }

  text(): string {
    return this.out.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
}

/** Does a `.text` / rich paragraph open with <strong>/<b> (nothing but whitespace before it)? */
function opensBold(container: cheerio.Cheerio<cheerio.Element>): boolean {
  for (const n of container.contents().toArray() as Node[]) {
    if (n.type === 'text') { if (textOf(n).trim()) return false; continue; }
    if (n.type !== 'tag') continue;
    const tag = (n as cheerio.Element).tagName.toLowerCase();
    return tag === 'strong' || tag === 'b';
  }
  return false;
}

function mediaKindOf(cls: string, richKind?: string): AuditMediaKind {
  if (richKind === 'photo' || /\bphoto_wrap\b|\bmedia_photo\b/.test(cls)) return 'photo';
  if (richKind === 'video' || /video|animated/.test(cls)) return 'video';
  if (richKind === 'document' || /media_file|document|audio|voice/.test(cls)) return 'document';
  return 'other';
}

function addMedia(post: Pick<AuditPost, 'media'>, kind: AuditMediaKind, count = 1): void {
  if (!post.media) post.media = { kind, count };
  else post.media = { kind: post.media.kind === kind ? kind : 'other', count: post.media.count + count };
}

function pollOf($: $T, el: cheerio.Cheerio<cheerio.Element>): AuditPoll {
  const details = el.children('.details').first().text().trim();
  const options = el.find('.answer').toArray().map((a) => {
    const c = $(a).clone();
    c.find('.details').remove();
    return c.text().replace(/\s+/g, ' ').trim().replace(/^-\s*/, '');
  });
  return {
    question: el.find('.question').first().text().replace(/\s+/g, ' ').trim(),
    options,
    kind: /quiz/i.test(details) ? 'quiz' : 'regular',
    anonymous: /anonymous/i.test(details),
  };
}

/** A rich message (`.text.rich_message`): block by block into the sink; media items counted. */
function richInto($: $T, root: cheerio.Cheerio<cheerio.Element>, sink: TextSink, post: Pick<AuditPost, 'media'>): void {
  const walk = (blocks: cheerio.Element[]) => {
    for (const b of blocks) {
      const $b = $(b);
      const kind = $b.attr('data-rich-kind') ?? '';
      const cls = $b.attr('class') ?? '';
      if (/rich_media_item/.test(cls)) { addMedia(post, mediaKindOf('', kind)); continue; }
      if (/rich_list\b/.test(cls) || b.tagName === 'ul' || b.tagName === 'ol') {
        const ordered = b.tagName === 'ol';
        $b.children('li').toArray().forEach((li, i) => {
          sink.out += `${ordered ? `${i + 1}.` : '•'} `;
          const inner = $(li).find('.rich_block').toArray();
          if (inner.length) inner.forEach((p, k) => { if (k) sink.out += ' '; sink.inline($, p.children as Node[]); });
          else sink.inline($, li.children as Node[]);
          sink.out += '\n';
        });
        sink.para();
        continue;
      }
      if (/rich_quote\b/.test(cls)) {
        const inner = $b.find('.rich_block').toArray();
        if (inner.length) walk(inner); else { sink.inline($, b.children as Node[]); sink.para(); }
        continue;
      }
      if (/rich_divider/.test(cls)) { sink.para(); continue; }
      sink.inline($, b.children as Node[]);
      sink.para();
    }
  };
  walk(root.children('.rich_block').toArray());
}

export interface ParseOptions {
  /** The resource zone the posts are judged in (the export only has an offset). Default Europe/Kyiv. */
  timezone?: string;
}

/** Parses one export page's HTML (pure). `channel` overrides the header title (for a continuation page). */
export function parseTelegramExportHtml(html: string, opts: ParseOptions & { channel?: string } = {}): AuditPost[] {
  const $ = cheerio.load(html);
  const channel = opts.channel ?? ($('.page_header .text.bold').first().text().replace(/\s+/g, ' ').trim() || 'channel');
  const slug = channelSlug(channel);
  const timezone = opts.timezone ?? 'Europe/Kyiv';
  const posts: AuditPost[] = [];

  for (const el of $('.history > .message').toArray()) {
    const $m = $(el);
    if ($m.hasClass('service')) continue;
    const num = Number(($m.attr('id') ?? '').replace(/^message/, ''));
    const body = $m.children('.body').first();
    const dateTitle = body.children('.date').attr('title') ?? '';
    const publishedAt = exportDateToIso(dateTitle);
    if (!publishedAt) continue;

    const post: AuditPost = {
      id: `${slug}:${num}`, channel, publishedAt, timezone, text: '', links: [], buttons: [], hashtags: [], media: null,
      messageIds: [num],
    };
    const sink = new TextSink();

    for (const mw of body.children('.media_wrap').toArray()) {
      const $mw = $(mw);
      const poll = $mw.children('.media_poll');
      if (poll.length) { post.poll = pollOf($, poll.first()); continue; }
      for (const item of $mw.children().toArray()) addMedia(post, mediaKindOf($(item).attr('class') ?? ''));
    }

    const textEl = body.children('.text').first();
    if (textEl.length) {
      let bold: boolean;
      if (textEl.hasClass('rich_message')) {
        // The lead of a rich message is its first text block (a media item may come before it).
        const first = textEl.children('.rich_block').filter((_i, b) => !/rich_media_item/.test($(b).attr('class') ?? '')).first();
        bold = first.length > 0 && /rich_paragraph/.test(first.attr('class') ?? '') && opensBold(first);
        richInto($, textEl, sink, post);
      } else {
        bold = opensBold(textEl);
        sink.inline($, textEl.contents().toArray() as Node[]);
      }
      // The lead is the whole first line when it opens bold («**За добу на** itch.io **зʼявились…**» is one lead).
      if (bold) post.lead = sink.text().split('\n')[0].trim() || undefined;
    }
    post.text = sink.text();
    post.links = sink.links;
    post.hashtags = sink.hashtags;
    if (sink.sourceUrl) post.sourceUrl = sink.sourceUrl;
    if (!post.lead) delete post.lead;

    for (const btn of body.find('.bot_buttons_table .bot_button').toArray()) {
      const a = $(btn).find('a').first();
      const text = (a.length ? a : $(btn)).text().replace(/\s+/g, ' ').trim();
      const url = a.attr('href');
      post.buttons.push(url && /^https?:/i.test(url) ? { text, url } : { text });
    }

    // An album part: only media, right after a post of the same chat → counted on that post.
    const prev = posts[posts.length - 1];
    if (!post.text && !post.poll && post.media && !post.buttons.length && prev && $m.hasClass('joined')) {
      addMedia(prev, post.media.kind, post.media.count);
      prev.messageIds = [...(prev.messageIds ?? []), num];
      continue;
    }
    if (!post.text && !post.poll && !post.media) continue;
    posts.push(post);
  }
  return posts;
}

/** `messages.html`, `messages2.html`, … of an export dir in page order. */
export function exportPages(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => /^messages\d*\.html$/.test(f))
    .sort((a, b) => Number(a.replace(/\D/g, '') || 1) - Number(b.replace(/\D/g, '') || 1))
    .map((f) => join(dir, f));
}

/** Every post of one export dir (all pages; album parts that continue on the next page are joined too). */
export function parseTelegramExportDir(dir: string, opts: ParseOptions = {}): AuditPost[] {
  const out: AuditPost[] = [];
  let channel: string | undefined;
  for (const page of exportPages(dir)) {
    const html = readFileSync(page, 'utf8');
    const posts = parseTelegramExportHtml(html, { ...opts, channel });
    channel ??= posts[0]?.channel;
    out.push(...posts);
  }
  return out;
}

/**
 * Export dirs under `paths`: each path is an export dir itself (has messages.html) or a folder of export dirs
 * (one level down), e.g. `channels - logs/`. Sorted by name.
 */
export function findExportDirs(paths: string[]): string[] {
  const dirs: string[] = [];
  for (const p of paths) {
    if (exportPages(p).length) { dirs.push(p); continue; }
    for (const name of readdirSync(p).sort()) {
      const sub = join(p, name);
      if (statSync(sub).isDirectory() && exportPages(sub).length) dirs.push(sub);
    }
  }
  return dirs;
}
