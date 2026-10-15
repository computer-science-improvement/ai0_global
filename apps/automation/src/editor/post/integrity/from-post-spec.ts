import type { PostSpec } from '../post-spec';
import { inlineToPlain } from '../inline-markup';
import { blockPlain } from '../blocks';
import { normalizeHashtag, type RenderCard } from '../render-telegram';
import type { AuditPost } from './types';

/**
 * Spec 037 FR-001: a PostSpec (before publishing) → the `AuditPost` the integrity checks read, so the publish guards
 * and lintPost can run the same checks as the export audit. The text is what the Telegram reader sees, in the same
 * shape as a parsed export: blocks as plain text (lists with `•`, numbered lists with `1.`) split by blank lines,
 * then the `→ Source` line (linkStyle inline), the footer / `Джерело:` line and the hashtags, like composeText.
 * Carousel slides and the longread article follow the body, as in lintPost's reader text.
 */

export interface PostSpecMeta {
  /** Slot id (or any stable id). */
  id: string;
  /** Channel key or title. */
  channel: string;
  /** Scheduled publish time, ISO with offset (or Z). */
  publishedAt: string;
  /** Resource zone (card.timezone). */
  timezone: string;
  /** How the source / footer render; default: inline source, no footer. */
  card?: Partial<RenderCard>;
  /** Spec 037 T9: the planner's topic of a fixed slot (a live slot's topic is only a label). */
  topic?: string;
}

/** `[label](https://…)` links of inline markup (the same syntax inlineToHtml renders). */
const LINK_RE = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,2000})\)/g;

function linksOf(src: string): { text: string; url: string }[] {
  return [...(src ?? '').matchAll(LINK_RE)].map((m) => ({ text: inlineToPlain(m[1]), url: m[2] }));
}

/** Every inline string of the spec that may carry links (blocks, nested details, longread). */
function inlineStrings(blocks: PostSpec['body']): string[] {
  return blocks.flatMap((b): string[] => {
    switch (b.type) {
      case 'list':
      case 'olist':   return b.items;
      case 'table':   return [...b.header, ...b.rows.flat()];
      case 'details': return [b.title, ...inlineStrings(b.body)];
      case 'math':
      case 'code':
      case 'divider': return [];
      default:        return [b.text];
    }
  });
}

function sourceLabel(spec: PostSpec): string {
  if (spec.source?.label) return spec.source.label;
  try { return new URL(spec.source!.url).hostname.replace(/^www\./, ''); } catch { return 'Джерело'; }
}

export function auditPostFromSpec(spec: PostSpec, meta: PostSpecMeta): AuditPost {
  const linkStyle = meta.card?.linkStyle ?? 'inline';
  const plain = (blocks: PostSpec['body']) => blocks.map((b) => blockPlain(b, inlineToPlain)).filter((s) => s.trim()).join('\n\n');

  const parts: string[] = [plain(spec.body)];
  if (spec.format === 'carousel') for (const s of spec.slides ?? []) parts.push(`${s.title}\n${s.text}`);
  if (spec.format === 'longread' && spec.longread) parts.push(spec.longread.title, plain(spec.longread.blocks));
  if (spec.source && linkStyle === 'inline') parts.push(`→ ${sourceLabel(spec)}`);
  const tail: string[] = [];
  if (meta.card?.footer) tail.push(meta.card.footer);
  if (spec.source && linkStyle === 'footer') tail.push(`Джерело: ${sourceLabel(spec)}`);
  const hashtags = spec.hashtags.map(normalizeHashtag);
  if (hashtags.length) tail.push(hashtags.map((h) => `#${h}`).join(' '));
  if (tail.length) parts.push(tail.join('\n'));

  const links = [
    ...inlineStrings([...spec.body, ...(spec.format === 'longread' ? spec.longread?.blocks ?? [] : [])]).flatMap(linksOf),
    ...(spec.source && linkStyle !== 'button' ? [{ text: sourceLabel(spec), url: spec.source.url }] : []),
  ];
  const buttons = [
    ...(spec.cta ? [{ text: spec.cta.label, url: spec.cta.url }] : []),
    ...(spec.source && linkStyle === 'button' ? [{ text: `Джерело: ${sourceLabel(spec)}`.slice(0, 40), url: spec.source.url }] : []),
    ...spec.buttons.flat().map((b) => ({ text: b.text, url: b.url })),
  ];

  const first = spec.body[0];
  const isPoll = spec.format === 'poll' || spec.format === 'quiz';
  const mediaCount = spec.format === 'carousel' ? (spec.slides?.length ?? 0) : spec.media.length;
  const mediaKind = spec.format === 'video' || spec.media.some((m) => m.kind === 'video') ? 'video' : 'photo';

  const post: AuditPost = {
    id: meta.id,
    channel: meta.channel,
    publishedAt: meta.publishedAt,
    timezone: meta.timezone,
    text: parts.filter((p) => p.trim()).join('\n\n'),
    links,
    buttons,
    hashtags,
    media: mediaCount ? { kind: mediaKind, count: mediaCount } : null,
    format: spec.format,
    ...(meta.topic ? { topic: meta.topic } : {}),
  };
  // Spec 037 T11: the images the post shows and its title, for the media check (source image, posters).
  const imageUrls = [...spec.media.filter((m) => m.kind !== 'video').map((m) => m.url), ...(spec.format === 'carousel' ? (spec.slides ?? []).flatMap((s) => (s.image ? [s.image] : [])) : [])];
  if (imageUrls.length && spec.format !== 'video') post.imageUrls = imageUrls;
  if (spec.title) post.title = spec.title;
  if (first?.type === 'lead') post.lead = inlineToPlain(first.text);
  // Spec 037 T2: a spec always says what it is in its story (an empty story = an original post).
  post.story = {
    ...(spec.story?.key ? { key: spec.story.key } : {}), ...(spec.story?.followup_of ? { followupOf: spec.story.followup_of } : {}),
    ...(spec.story?.kind ? { kind: spec.story.kind } : {}), ...(spec.story?.new_facts?.length ? { newFacts: spec.story.new_facts } : {}),
    ...(spec.story?.decision ? { decision: spec.story.decision } : {}),
    ...(spec.story?.event_at ? { eventAt: spec.story.event_at, ...(spec.story.event ? { eventName: spec.story.event } : {}) } : {}),
  };
  if (spec.source && linkStyle === 'inline') post.sourceUrl = spec.source.url;
  if (spec.source) post.citedSourceUrl = spec.source.url;
  if (isPoll && spec.poll) {
    post.poll = {
      question: inlineToPlain(spec.poll.question),
      options: spec.poll.options.map(inlineToPlain),
      kind: spec.format === 'quiz' ? 'quiz' : 'regular',
      anonymous: spec.poll.anonymous,
      ...(spec.format === 'quiz' && spec.poll.correct_index !== undefined ? { correctIndex: spec.poll.correct_index } : {}),
      ...(spec.format === 'quiz' && spec.poll.explanation ? { explanation: inlineToPlain(spec.poll.explanation) } : {}),
    };
  }
  return post;
}
