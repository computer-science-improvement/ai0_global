import type { DocCodeBlock, DocImage, DocLink, RawSection } from './doc-types';

/**
 * Spec 065 FR-002: markdown read as structure, not as an article. Every section (by heading, any level) keeps its text
 * with newlines, its fenced code blocks whole with their language, and its images and links with their position, in
 * document order — so a list of entries (heading → picture → prompt → source) stays bound.
 *
 * Inline `<img>` tags are rewritten to `![alt](src)` in the text (shorter, one form for the model to read); nothing
 * else of the source is changed, so offsets index the returned `text`.
 */
export interface ParsedMarkdown {
  text:     string;
  sections: RawSection[];
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/;
const IMG_TAG = /<img\b[^>]*>/gi;
const IMG_MD = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const LINK_MD = /\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const LINK_HTML = /<a\b[^>]*?\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

const attr = (tag: string, name: string): string | null =>
  new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)?.slice(1).find((v) => v !== undefined) ?? null;

/** `<img src alt>` → `![alt](src)`; a tag with no src goes. */
function rewriteImgTags(line: string): string {
  if (!/<img\b/i.test(line)) return line;
  return line.replace(IMG_TAG, (tag) => {
    const src = attr(tag, 'src');
    if (!src) return '';
    return `![${(attr(tag, 'alt') ?? '').replace(/[[\]]/g, '').trim()}](${src.trim()})`;
  });
}

const plainText = (s: string) => s.replace(/<[^>]+>/g, '').replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim();

/** A heading as text: links reduced to their words, emphasis and code marks dropped. */
export function cleanHeading(raw: string): string {
  return plainText(raw.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
}

/** Resolved against `base`; http(s) only. */
function resolve(href: string, base: string): string | null {
  try {
    const u = new URL(href.trim(), base);
    return /^https?:$/.test(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

function scanLine(line: string, at: number, base: string, images: DocImage[], links: DocLink[]): void {
  for (const m of line.matchAll(IMG_MD)) {
    const src = resolve(m[2], base);
    if (src) images.push({ src, alt: m[1].trim(), at: at + m.index! });
  }
  // Links are read with the images blanked out (offsets kept), so a badge `[![alt](img)](target)` is a link with no words.
  const bare = line.replace(IMG_MD, (m) => ' '.repeat(m.length));
  for (const m of bare.matchAll(LINK_MD)) {
    const url = m[2].startsWith('#') ? null : resolve(m[2], base);
    const text = plainText(m[1]);
    if (url && text) links.push({ text, url, at: at + m.index! });
  }
  for (const m of bare.matchAll(LINK_HTML)) {
    const url = m[1].startsWith('#') ? null : resolve(m[1], base);
    const text = plainText(m[2]);
    if (url && text) links.push({ text, url, at: at + m.index! });
  }
}

export function parseMarkdown(source: string, baseUrl: string): ParsedMarkdown {
  const lines = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  let text = '';
  const sections: RawSection[] = [];
  const st: { cur: RawSection | null } = { cur: null };
  let fence: { ch: string; len: number; lang: string; start: number; body: string[] } | null = null;

  const open = (heading: string, level: number, start: number) => {
    if (st.cur) st.cur.end = start;
    st.cur = { heading, level, start, end: start, images: [], links: [], code_blocks: [] };
    sections.push(st.cur);
  };

  for (const rawLine of lines) {
    const start = text.length;
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence.ch === '`' ? '`' : '~'}{${fence.len},}[ \\t]*$`);
      const closing = close.test(rawLine);
      text += rawLine + '\n';
      if (closing) {
        const block: DocCodeBlock = { lang: fence.lang, text: fence.body.join('\n'), start: fence.start, end: start + rawLine.length };
        st.cur!.code_blocks.push(block);
        fence = null;
      } else {
        fence.body.push(rawLine);
      }
      continue;
    }
    const f = FENCE_OPEN.exec(rawLine);
    if (f) {
      if (!st.cur) open('', 0, start);
      fence = { ch: f[1][0], len: f[1].length, lang: f[2], start, body: [] };
      text += rawLine + '\n';
      continue;
    }
    const line = rewriteImgTags(rawLine);
    const h = HEADING.exec(line);
    if (h) open(cleanHeading(h[2]), h[1].length, start);
    else if (!st.cur && line.trim()) open('', 0, start);
    if (st.cur) scanLine(line, start, baseUrl, st.cur.images, st.cur.links);
    text += line + '\n';
  }
  // A fence that never closes runs to the end of the file.
  if (fence) {
    const block: DocCodeBlock = { lang: fence.lang, text: fence.body.join('\n'), start: fence.start, end: text.length };
    (st.cur ?? (open('', 0, 0), st.cur!)).code_blocks.push(block);
  }
  if (st.cur) st.cur.end = text.length;
  return { text, sections };
}

/** Badge and chrome images of a README (shields, build status) are not pictures for a post. */
export const isBadgeImage = (src: string): boolean => /(?:img\.shields\.io|badge|rawgit|travis-ci|github\.com\/[^/]+\/[^/]+\/(?:workflows|actions)\/|star-history|trendshift)/i.test(src);
