import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bodyText, type AuditCard, type AuditPost } from '../../post/integrity/types';
import { PostSpecSchema, type PostSpec } from '../../post/post-spec';
import { implementedCodes } from '../../post/integrity/registry';
import { parseLabelCode } from '../../post/integrity/codes';

/**
 * Spec 037 T14 (tests only): a golden-set post (a parsed Telegram export, T1) as the PostSpec an agent would have
 * written, so the post audit can be run on it as a published slot: the bold lead and paragraphs, `•` lists and
 * numbered lists as blocks, the `→ Source` line as `source` (label kept), hashtags, buttons, the poll, placeholder
 * media of the same kind and count. Round-tripped through `auditPostFromSpec`, the reader text is the export's.
 */

const ARROW = /^→\s*(.+)$/;

/** The export's inline links back as `[text](url)` at their text's first occurrence (the source line is rendered by code). */
function withLinks(body: string, p: AuditPost): string {
  let out = body;
  // The last link to the source is the code-rendered `→` line; an earlier one (spec 063 FR-006) is an inline anchor.
  const arrowAt = p.links.map((l) => l.url).lastIndexOf(p.sourceUrl ?? '\0');
  for (const [i, l] of p.links.entries()) {
    if (i === arrowAt || !l.text.trim()) continue;
    const at = out.indexOf(l.text);
    if (at >= 0 && !out.slice(Math.max(0, at - 1), at).includes('[')) out = `${out.slice(0, at)}[${l.text}](${l.url})${out.slice(at + l.text.length)}`;
  }
  return out;
}

function blocksOf(p: AuditPost): PostSpec['body'] {
  const chunks = withLinks(bodyText(p), p).split(/\n\s*\n/).map((c) => c.trim()).filter(Boolean);
  const out: PostSpec['body'] = [];
  chunks.forEach((chunk, i) => {
    const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.every((l) => l.startsWith('• '))) { out.push({ type: 'list', items: lines.map((l) => l.slice(2).trim()) }); return; }
    if (lines.length > 1 && lines.every((l) => /^\d+[.)]\s/.test(l))) { out.push({ type: 'olist', items: lines.map((l) => l.replace(/^\d+[.)]\s+/, '')) }); return; }
    if (i === 0 && p.lead && chunk.startsWith(p.lead)) {
      out.push({ type: 'lead', text: p.lead });
      const rest = chunk.slice(p.lead.length).trim();
      if (rest) out.push({ type: 'p', text: rest });
      return;
    }
    out.push({ type: 'p', text: chunk });
  });
  return out;
}

/**
 * The PostSpec of a golden post (validated; throws when the post does not fit the schema). `story` is what the writer
 * declared (spec 037 T2; see goldenStory): a spec without one is an original post.
 */
export function specOfGoldenPost(p: AuditPost, story?: PostSpec['story']): PostSpec {
  const label = p.text.split('\n').map((l) => l.trim()).map((l) => l.match(ARROW)?.[1]).find(Boolean);
  const media = p.media ? Array.from({ length: Math.min(p.media.count, 10) }, (_, i) => ({
    url: `https://example.com/golden/${encodeURIComponent(p.id)}-${i}.${p.media!.kind === 'video' ? 'mp4' : 'jpg'}`,
    ...(p.media!.kind === 'video' ? { kind: 'video' as const } : {}),
  })) : [];
  const format: PostSpec['format'] = p.poll ? (p.poll.kind === 'quiz' ? 'quiz' : 'poll')
    : p.media?.kind === 'video' ? 'video' : media.length > 1 ? 'album' : media.length ? 'photo' : 'text';
  const buttons = p.buttons.filter((b) => b.url && /^https?:\/\//.test(b.url)).slice(0, 12).map((b) => ({ text: b.text.slice(0, 40), url: b.url! }));
  const rows: Array<typeof buttons> = [];
  for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));
  return PostSpecSchema.parse({
    format, title: (p.lead || p.text || p.poll?.question || p.id).slice(0, 100).padEnd(3, '.'), origin: p.sourceUrl ? 'external' : 'original',
    body: blocksOf(p), media: p.poll ? [] : media, hashtags: p.hashtags.slice(0, 10),
    ...(p.sourceUrl ? { source: { url: p.sourceUrl, ...(label ? { label: label.slice(0, 60) } : {}) } } : {}),
    buttons: rows.slice(0, 4),
    ...(story ? { story } : {}),
    ...(p.poll ? {
      poll: {
        question: p.poll.question.slice(0, 300), options: p.poll.options.map((o) => o.slice(0, 100)).slice(0, 10), anonymous: p.poll.anonymous,
        ...(p.poll.correctIndex !== undefined ? { correct_index: p.poll.correctIndex } : {}),
        ...(p.poll.explanation ? { explanation: p.poll.explanation.slice(0, 200) } : {}),
      },
    } : {}),
  });
}

// ── the golden set and its labels ────────────────────────────────────────────

const TESTING = join(__dirname, '..', '..', 'post', 'testing');

export interface GoldenSet {
  posts:  AuditPost[];
  labels: {
    cards: Record<string, AuditCard & { note?: string }>; posts: Record<string, { expect: string[] }>;
    story_pairs?: { allowed_followup?: Array<{ a: string; b: string; note?: string }> };
  };
}

export function loadGolden(): GoldenSet {
  return {
    posts: (JSON.parse(readFileSync(join(TESTING, 'channel-logs-2026-10.json'), 'utf8')) as { posts: AuditPost[] }).posts,
    labels: JSON.parse(readFileSync(join(TESTING, 'channel-logs-2026-10.labels.json'), 'utf8')),
  };
}

/** The labelled card of a golden channel (timezone, style sheet, caps). */
export function goldenCard(g: GoldenSet, channel: string): AuditCard {
  const { note: _note, ...card } = g.labels.cards[channel];
  return card;
}

/**
 * Spec 037 T2: the story a writer declares on a labelled allowed follow-up (`story_pairs.allowed_followup`): a giveaway
 * reminder or a follow-up of the original. `idOf` maps a golden id to the id the audit knows the original by (a slot id).
 */
export function goldenStory(g: GoldenSet, id: string, idOf: (goldenId: string) => string | undefined = (x) => x): PostSpec['story'] | undefined {
  const pair = g.labels.story_pairs?.allowed_followup?.find((x) => x.b === id);
  const of = pair ? idOf(pair.a) : undefined;
  if (!pair || !of) return undefined;
  return { followup_of: of, kind: /reminder/i.test(pair.note ?? '') ? 'reminder' : 'followup' };
}

/** The codes the labels expect of a post that a registered check finds now (`@Tn` markers are still pending). */
export function expectedNow(g: GoldenSet, id: string): string[] {
  const implemented = implementedCodes();
  const codes = g.labels.posts[id].expect.filter((l) => !parseLabelCode(l).pendingTask).map((l) => parseLabelCode(l).code);
  return [...new Set(codes.filter((c) => implemented.has(c)))].sort();
}
