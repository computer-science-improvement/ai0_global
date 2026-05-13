import { AdRef } from '../types';

export interface MessageEntity {
  type:   'mention' | 'mention_name' | 'url' | 'text_url' | string;
  offset: number;
  length: number;
  url?:   string;
}

export interface ExtractInput {
  text:                 string;
  entities:             MessageEntity[];
  forwardFromUsername?: string | null;
}

const TME_RE       = /^https?:\/\/t\.me\/([A-Za-z0-9_]+)(?:\/(\d+))?/i;
const INSTA_RE     = /^https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]+)/i;
const GENERIC_RE   = /^https?:\/\/(?:www\.)?([A-Za-z0-9.\-]+)/i;
const MENTION_RE   = /^@?([A-Za-z0-9_]+)$/;

export function extractAdRefs(input: ExtractInput): AdRef[] {
  const refs: AdRef[] = [];
  const seen = new Set<string>();

  const push = (ref: AdRef) => {
    const key = `${ref.kind}:${(ref as any).username ?? (ref as any).domain}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };

  if (input.forwardFromUsername) {
    push({ kind: 'tg_channel', username: input.forwardFromUsername.toLowerCase(), forward: true });
  }

  for (const e of input.entities) {
    const slice = input.text.slice(e.offset, e.offset + e.length);
    const url   = (e as any).url ?? slice;

    if (e.type === 'mention') {
      const m = MENTION_RE.exec(slice);
      if (m) push({ kind: 'tg_channel', username: m[1].toLowerCase() });
      continue;
    }

    if (e.type === 'url' || e.type === 'text_url') {
      const tme = TME_RE.exec(url);
      if (tme) {
        const ref: AdRef = { kind: 'tg_channel', username: tme[1].toLowerCase() };
        if (tme[2]) (ref as any).target_post_id = parseInt(tme[2], 10);
        push(ref);
        continue;
      }
      const ig = INSTA_RE.exec(url);
      if (ig) { push({ kind: 'instagram', username: ig[1].toLowerCase() }); continue; }
      const g = GENERIC_RE.exec(url);
      if (g)  { push({ kind: 'web', domain: g[1].toLowerCase() }); continue; }
    }
  }

  return refs;
}
