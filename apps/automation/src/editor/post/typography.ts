import type { Block, InnerBlock, PostSpec } from './post-spec';
import { attributionOf, fixHomoglyphWord, sourceNames } from './text-hygiene';
import { sentencesOf } from './slop-lint';
import { inlineToPlain } from './inline-markup';
import { dropDuplicateSourceLink } from './source-link';

/**
 * Spec 037 T6: the typography normaliser — the code, not the model, owns these details. Pure and idempotent:
 *   • an apostrophe between Cyrillic letters (' ’ ‘ ` ′) → ʼ (U+02BC): «з'явились» and «зʼявиться» in one channel;
 *   • straight double quotes in Ukrainian text → «»;
 *   • runs of spaces inside a line → one space;
 *   • Latin look-alike letters inside an otherwise Cyrillic word → Cyrillic («пpивіт» → «привіт»).
 * Never touches URLs (bare or in `[label](url)`), inline code, hashtags, @mentions or e-mails; Latin words stay as
 * they are (a word is only changed when it already has more Cyrillic than Latin letters).
 */

/** Spans the normaliser must leave alone, in priority order. */
const PROTECTED = new RegExp([
  '`[^`\\n]+`',                              // inline code
  '\\]\\(https?:\\/\\/[^\\s)]+\\)',          // the URL part of [label](url)
  'https?:\\/\\/[^\\s<>«»"]+',               // bare URLs
  'www\\.[^\\s<>«»"]+',
  '[\\w.+-]+@[\\w-]+\\.[\\w.-]+',            // e-mail
  '(?<![\\p{L}\\p{N}])[#@][\\p{L}\\p{N}_]+', // hashtags, @mentions
].join('|'), 'gu');

const HOLD_OPEN = '';
const HOLD_CLOSE = '';
const HOLD_RE = /(\d+)/g;

const APOSTROPHE = /(?<=\p{Script=Cyrillic})['’‘`′](?=\p{Script=Cyrillic})/gu;
/**
 * A pair of straight quotes: opening after start / space / bracket / dash, closing before end / space / punctuation;
 * a held span (e.g. the `](url)` of a link) counts as a boundary on either side.
 */
const STRAIGHT_QUOTES = /(^|[\s([{—–-])"(?=[^\s"])([^"\n]*?[^\s"])"(?=$|[\s.,;:!?…)\]}—–-])/gu;
const SPACES = /(?<=\S)[ \t]{2,}(?=\S)/g;
const WORDS = /[\p{L}\p{M}]+/gu;
const HAS_CYRILLIC = /\p{Script=Cyrillic}/u;

/** One inline string (post text with inline markup, a caption, a slide). */
export function normalizeTypography(text: string): string {
  if (!text || !HAS_CYRILLIC.test(text)) return text;
  const held: string[] = [];
  let s = text.replace(PROTECTED, (m) => { held.push(m); return `${HOLD_OPEN}${held.length - 1}${HOLD_CLOSE}`; });
  s = s.replace(WORDS, (w) => fixHomoglyphWord(w));
  s = s.replace(APOSTROPHE, 'ʼ');
  s = s.replace(STRAIGHT_QUOTES, (_m, before: string, inner: string) => `${before}«${inner}»`);
  s = s.replace(SPACES, ' ');
  return s.replace(HOLD_RE, (_m, i: string) => held[Number(i)]);
}

function normBlock<B extends Block | InnerBlock>(b: B): B {
  const t = normalizeTypography;
  switch (b.type) {
    case 'list':
    case 'olist':   return { ...b, items: b.items.map(t) };
    case 'table':   return { ...b, header: b.header.map(t), rows: b.rows.map((r) => r.map(t)) };
    case 'details': return { ...b, title: t(b.title), body: b.body.map(normBlock) };
    case 'code':
    case 'math':
    case 'divider': return b;
    default:        return { ...b, text: t((b as { text: string }).text) } as B;
  }
}

/**
 * Spec 037 T6 `duplicate_attribution` auto-fix: the code always renders `spec.source` (the `→ X` line, the
 * «Джерело: X» footer or a button), so a closing «Джерело: X» / «За даними X» of the body that names the same
 * source is dropped — the whole last block when that is all it says, else its last sentence. An attribution
 * carrying a link of its own (another article) stays.
 */
export function dropDuplicateAttribution(spec: PostSpec): PostSpec {
  if (!spec.source || !spec.body.length) return spec;
  const last = spec.body[spec.body.length - 1];
  if (last.type !== 'p' && last.type !== 'footer') return spec;
  if (/\]\(https?:\/\//.test(last.text) && !last.text.includes(`](${spec.source.url})`)) return spec;
  const names = sourceNames(spec.source.url, spec.source.label);
  const plain = inlineToPlain(last.text).trim();
  const ss = sentencesOf(plain);
  const tail = ss.at(-1);
  if (!tail || !attributionOf(tail, names)) return spec;
  if (ss.length === 1) return { ...spec, body: spec.body.slice(0, -1) };
  // Cut the markup text at the attribution's first word; only after plain whitespace, so no bold / italic is split.
  const cut = last.text.lastIndexOf(tail.split(/\s+/)[0]);
  if (cut <= 0 || !/\s/.test(last.text[cut - 1])) return spec;
  const rest = last.text.slice(0, cut).trimEnd();
  if (!rest) return spec;
  return { ...spec, body: [...spec.body.slice(0, -1), { ...last, text: rest }] };
}

/**
 * The PostSpec an agent wrote, normalised before lint and render (AgentPostSpecSchema applies it, so publish_post,
 * lint_post and the composer see the same text). Every reader-visible string is normalised; hashtags, URLs, code
 * and math blocks are not.
 */
export function normalizePostSpec(spec: PostSpec): PostSpec {
  const t = normalizeTypography;
  const out: PostSpec = {
    ...spec,
    body: spec.body.map(normBlock),
    buttons: spec.buttons.map((row) => row.map((b) => ({ ...b, text: t(b.text) }))),
  };
  if (spec.cta) out.cta = { ...spec.cta, label: t(spec.cta.label) };
  if (spec.slides) out.slides = spec.slides.map((s) => ({ ...s, title: t(s.title), text: t(s.text) }));
  if (spec.poll) {
    out.poll = {
      ...spec.poll, question: t(spec.poll.question), options: spec.poll.options.map(t),
      ...(spec.poll.explanation ? { explanation: t(spec.poll.explanation) } : {}),
    };
  }
  if (spec.longread) out.longread = { ...spec.longread, title: t(spec.longread.title), blocks: spec.longread.blocks.map(normBlock) };
  // Spec 063 FR-006: one link per source — the inline anchor to `spec.source` becomes plain text.
  return dropDuplicateSourceLink(dropDuplicateAttribution(out));
}
