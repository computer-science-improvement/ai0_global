import type { SteeringPromptRule } from '../steering/steering.types';
import { createHash } from 'crypto';
import type { AgentBudget } from '../harness/budget.service';
import { isToolError, type EditorTool, type ToolContext, type ToolError } from '../harness/tool';
import type { InboxItemInput } from '../agents/owner-inbox';
import type { EditorPlansRepository } from '../repo/editor-plans.repository';
import type { VoicePrefs } from '../post/slop-lint';
import type { EditorRole } from '../llm/llm.types';
import { criticLine, slopCodes, type StoredCritic } from './critic';
import { brokenCharText, findBrokenChars } from '../post/text-hygiene';
import { CRITIC_TIMEOUT_MS, type CriticRequest, type CriticService } from './critic.service';
import type { CriticSkillsContext } from './critic-skills';
import { dateFromUrl, normalizePublishedAt } from '../post/dates';
import type { AuditSource } from '../post/integrity/types';
import type { CriticDates } from './critic-dates';
import type { CriticStoryContext } from '../story/story-context';
import { sourcePassages, type GroundingSource, type SourcePage } from '../post/grounding';
import { groundingCheckOf, READ_DISPLAY_CAP } from './critic-passages';
import { lowerCoverage, PAGE_CAP, ReadCapture, type SourceCoverage } from './read-capture';
import { LIBRARY_ROW_CAP } from './critic-source';
import type { DocStore } from '../docs/doc-store';
import { criticMediaOf } from './critic-media';
import type { PosterDecision } from '../post/integrity/checks/media';
import { storedSourcesOf, type StoredSource } from './stored-sources';
import { applySpecEdits, lintFixes, type TextEdit } from './spec-edits';
import { guardEdits } from './safe-edits';
import { dashFixes } from '../post/dash-fix';
import { draftRisk } from './critic-risk';
import type { OwnerRuleLine } from '../rules/owner-rules-prompt';

/** Publish tools wait for the critic (two attempts) and then for the send itself. */
export const PUBLISH_TOOL_TIMEOUT_MS = 2 * CRITIC_TIMEOUT_MS + 60_000;

/** Extra turns the AgentLoop grants after a `critic_revise`, so a revise near the step limit still ends in publish or skip. */
export const CRITIC_REVISE_GRANT_STEPS = 2;

/** What a publish tool hands the critic: the reader-visible text, the spec and every lint warning (spec 037 T6). */
export interface CriticPost {
  text:     string;
  spec:     unknown;
  format:   string;
  warnings: ReadonlyArray<{ code: string; message: string; fix?: TextEdit }>;
  /**
   * Spec 041 FR-002: runs the publish tool's guards (lint first) and render again on an edited spec. Without it the
   * gate never edits (the critic's edits stay on the verdict as advice).
   */
  relint?:  (spec: unknown) => Promise<RelintResult>;
  /** Spec 037 T5: the (scheduled) publish instant and the resource zone, for the critic's date line. */
  publishAt?: string;
  timezone?:  string;
  /** Spec 037 T2: the story's earlier posts (the story guard), null for a new story. */
  story?:     CriticStoryContext | null;
  /** Spec 067 A5: the code's poster decision for this post (set whether or not it has an image); the publish tool computes it from the AuditPost it lints. */
  poster?:    PosterDecision;
}

/** Spec 041 FR-002: the guards on an edited spec — `state` is whatever the publish tool needs to go on with it. */
export type RelintResult = { ok: true; state?: unknown } | { ok: false; errors: string[] };

/**
 * The gate's answer to a publish tool:
 * - `proceed`: store / publish / create the approval card (the verdict is already on the slot); with `edited`, the
 *   spec code edited after the pass (spec 041 FR-002) and the guards' state for it replace the tool's own;
 * - `revise`: return `result` (a tool error with the notes) — the executor rewrites once;
 * - `halt`: the slot is already `skipped` (reject) or `failed` (critic error); return `result` to end the run;
 * - `blocked`: the text has a broken character (spec 037 T6) — return `result`, the executor rewrites the word; the
 *   critic is not called and nothing is stored.
 */
export type CriticGateOutcome =
  | { kind: 'proceed'; critic: StoredCritic; edited?: EditedSpec }
  | { kind: 'blocked'; result: ToolError }
  | { kind: 'revise'; critic: StoredCritic; result: ToolError & { _grantSteps: number } }
  | { kind: 'halt'; critic: StoredCritic; result: Record<string, unknown> };

export interface EditedSpec { spec: unknown; state?: unknown }

export interface CriticGateDeps {
  critic: Pick<CriticService, 'review'>;
  plans:  Pick<EditorPlansRepository, 'updateSlot'>;
  inbox?: (i: InboxItemInput) => Promise<unknown>;
  /** Text of a library / data row behind `library_ref` (the critic's source excerpt). */
  libraryText?: (ref: string) => Promise<string | null>;
  /**
   * Spec 067 FR-001: the store `read_doc` / `find_in_doc` read, so the critic sees the parts of a big document the
   * author read. The gate never makes one (tests inject `new DocStore()`).
   */
  docs?: Pick<DocStore, 'get' | 'urlOf'>;
}

/** The slot and resource context of one executor run (built by the runner). */
export interface CriticGateContext {
  slotId:       string;
  channelKey:   string;
  mode:         'live' | 'shadow' | 'approve';
  resourceRef:  string;
  platform:     string;
  topic?:       string | null;
  angle?:       string | null;
  card?:        { models?: Partial<Record<EditorRole, string>>; dailyBudgetUsd?: number | null; language?: string | null } | null;
  voice:        VoicePrefs;
  brief?:       string | null;
  profile?:     string | null;
  formatPrefs?: string | null;
  playbook?:    string | null;
  /** Spec 034 FR-008: the resource's examples (renderExamples) for the critic's reference. */
  examples?:    string | null;
  agent?:       AgentBudget | null;
  /** The orchestrator the Inbox item belongs to. */
  inboxAgentId?: string | null;
  /** Spec 037 FR-012: the writer's skill selection inputs (resource tone skills, slot signals, the agent's skill view). */
  skills?:      CriticSkillsContext | null;
  /** Spec 040 FR-011: the channel's owner rules (the critic's `owner_rules` axis). */
  ownerRules?:  OwnerRuleLine[] | null;
  /** Spec 045 FR-005: the steering rules of the resource's active sets (advice for format_fit). */
  steering?:    SteeringPromptRule[] | null;
  /**
   * Spec 067 FR-004: critic passes this run may use (default 2 = a revise and one rewrite). The runner passes
   * min(2, 3 − passes the slot used so far), so a slot never spends more than MAX_CRITIC_PASSES_PER_SLOT in all. With 1
   * the first `revise` is final: live / shadow skip with `critic_rejected: cap_revise — …` (the verdict stays `revise`, so
   * the ladder still reads it as fixable), approval proceeds with `final: true`.
   */
  passBudget?:  number;
  /** Spec 067 FR-003: an earlier run of the slot (another ladder step, the 15-minute retry) was high: this run's critic stays high. */
  pinLevel?:    'high' | null;
}

/** Spec 067 FR-001: the head of a page the critic gets as an excerpt (a library row is up to LIBRARY_ROW_CAP). */
const SOURCE_CAP = 12_000;
/** The start of what was read the critic gets when nothing of the post is in a big document's parts (the rest is nav and noise). */
const READ_HEAD_CAP = 3_000;
/** Spec 037 T4: a page read in the run is kept whole (up to this), for grounding and the critic's passages. */
export { PAGE_CAP };

const READ_TOOLS = new Set(['web_fetch', 'fetch_feed', 'extract_images', 'read_doc', 'find_in_doc']);

const normUrl = (u: string): string => u.trim().replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
const hashOf = (v: unknown): string => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex');

/** The gate of one run, kept in ctx.extras.critic. */
export function criticGateOf(ctx: ToolContext): CriticGate | null {
  const g = ctx.extras?.critic;
  return g instanceof CriticGate ? g : null;
}

/**
 * Spec 034 FR-004: the pre-publish critic of one executor run. Publish tools
 * call `check` after every deterministic guard passed and before anything is
 * stored, sent or put up for approval:
 *
 * - pass → proceed;
 * - revise (first pass, budget for a second) → a `critic_revise` tool error with the notes; the
 *   executor rewrites exactly once in the same run (the loop grants 2 turns);
 * - revise (second pass, or the first when the slot's pass budget is 1) → live / shadow: rejected; approval: proceeds
 *   to the owner with the notes on the card (`final: true`);
 * - reject → the slot is skipped (`critic_rejected: …`);
 * - critic error / timeout / blocking cap (after one retry) → live / shadow:
 *   the slot fails with an Inbox entry, nothing is published; approval: the
 *   card is created with `verdict: 'error'` (the owner decides; never auto-approved).
 *
 * The verdict, scores and notes are written to `editor_slots.critic`.
 */
export class CriticGate {
  private passes = 0;
  /** Spec 067 FR-004: critic passes this run may use. */
  private readonly budget: number;
  /** Spec 041 FR-007: what the critic cost on this post so far (every pass, errors included). */
  private spent = 0;
  private first: StoredCritic | null = null;
  /** The spec that already proceeded: a retry of the same post after a later error is not reviewed again. */
  private proceeded: { hash: string; critic: StoredCritic; edited?: EditedSpec } | null = null;
  /** Spec 067 FR-001: the text of every page, document part and feed item the run read (`readTextOf`). */
  private readonly capture: ReadCapture;
  /** Spec 037 T5: what the run read, with the publication date when the page or the feed item gave one. */
  private readonly read = new Map<string, AuditSource>();
  /** Spec 037 T4: an aggregator page's links to the primary source (web_fetch `primary_links`). */
  private readonly primary = new Map<string, string[]>();
  /** Spec 037 T11: the main image of each page read (web_fetch `image`, extract_images `og_image`); null = none. */
  private readonly images = new Map<string, string | null>();
  /** Spec 037 T17: every image of each page read a news post may use (web_fetch / extract_images `images`). */
  private readonly pageImages = new Map<string, string[]>();

  constructor(private readonly d: CriticGateDeps, readonly c: CriticGateContext) {
    this.capture = new ReadCapture(d.docs);
    this.budget = Math.max(1, Math.floor(c.passBudget ?? 2));
  }

  /** Spec 067 FR-003: high once the slot has been read at the high level (this run's first pass or an earlier run), so a rewrite never drops to the light model. */
  private pinned(): 'high' | null {
    return this.c.pinLevel === 'high' || this.first?.route?.level === 'high' ? 'high' : null;
  }

  /**
   * Wrap the run's read tools so the critic sees the source text the executor read (web_fetch, fetch_feed and, spec 067,
   * the parts of a big document read_doc / find_in_doc returned).
   */
  wrapTools(tools: EditorTool[]): EditorTool[] {
    return tools.map((t) => {
      if (!READ_TOOLS.has(t.name)) return t;
      return {
        ...t,
        execute: async (input: any, ctx: ToolContext) => {
          const out = await t.execute(input, ctx);
          try { if (!isToolError(out)) this.remember(t.name, input, out); } catch { /* capture is best-effort */ }
          return out;
        },
      };
    });
  }

  private remember(tool: string, input: any, out: any): void {
    if (tool === 'extract_images') {
      if (typeof input?.url === 'string') this.images.set(normUrl(input.url), typeof out?.og_image === 'string' ? out.og_image : null);
      if (typeof input?.url === 'string') this.rememberImages(input.url, out?.og_image, out?.images);
      return;
    }
    if (tool === 'read_doc' || tool === 'find_in_doc') {
      // A document read without a web_fetch in this run: its address comes from the store, and it counts as read.
      const url = tool === 'read_doc' ? this.capture.readDoc(input, out) : this.capture.findInDoc(input, out);
      if (url && !this.read.has(normUrl(url))) this.read.set(normUrl(url), { url, publishedAt: null, title: null });
      return;
    }
    if (tool === 'web_fetch') {
      this.capture.webFetch(input, out);
      for (const u of [input?.url, out?.url]) if (typeof u === 'string') this.read.set(normUrl(u), { url: u, publishedAt: normalizePublishedAt(out?.published_at), title: out?.title ?? null });
      const primary = Array.isArray(out?.primary_links) ? out.primary_links.filter((x: unknown): x is string => typeof x === 'string') : [];
      for (const u of [input?.url, out?.url]) if (typeof u === 'string' && primary.length) this.primary.set(normUrl(u), primary);
      for (const u of [input?.url, out?.url]) if (typeof u === 'string') this.images.set(normUrl(u), typeof out?.image === 'string' ? out.image : null);
      for (const u of [input?.url, out?.url]) if (typeof u === 'string') this.rememberImages(u, out?.image, out?.images);
      return;
    }
    for (const it of Array.isArray(out?.items) ? out.items : []) {
      if (typeof it?.link !== 'string') continue;
      if (!this.read.has(normUrl(it.link))) this.read.set(normUrl(it.link), { url: it.link, publishedAt: normalizePublishedAt(it.date), title: it.title ?? null });
      const text = [it.title, it.date ? `(${it.date})` : null, it.snippet].filter(Boolean).join(' ');
      if (text && !this.capture.has(it.link)) this.capture.feedItem(it.link, text);
    }
  }

  /** Spec 037 T17: the page's main image and its article images (≤ 10, main first); nothing when the tool gave no list. */
  private rememberImages(url: string, main: unknown, list: unknown): void {
    if (!Array.isArray(list)) return;
    const all = [...(typeof main === 'string' ? [main] : []), ...list.filter((x): x is string => typeof x === 'string' && /^https?:\/\//i.test(x))];
    this.pageImages.set(normUrl(url), [...new Set(all)].slice(0, 10));
  }

  /**
   * Spec 067 FR-001: what the critic is shown of the cited source — the whole page (`full`), the parts of a big
   * document the author read (`read`), or the head / a feed item / a library row — and how much of the source that is.
   * The lowest coverage among the cited sources (the page, the library row) is the one reported.
   */
  private async source(spec: any, post?: CriticPost): Promise<CriticRequest['source']> {
    const url: string | null = typeof spec?.source?.url === 'string' ? spec.source.url : null;
    const ref: string | null = typeof spec?.library_ref === 'string' ? spec.library_ref : null;
    const dates = { publishedAt: post?.publishAt, timezone: post?.timezone };
    const cited = url ? this.capture.readTextOf(url) : null;
    const lib = ref && this.d.libraryText ? await this.d.libraryText(ref).catch(() => null) : null;
    // A library row at the cap was clipped: the critic read a part of it.
    const parts: SourceCoverage[] = [...(cited ? [cited.coverage] : []), ...(lib ? [lib.length >= LIBRARY_ROW_CAP ? 'read' as const : 'full' as const] : [])];
    const coverage: SourceCoverage = parts.length ? parts.reduce(lowerCoverage) : 'none';
    // Spec 037 T4: a page the run read gives the critic its title, date and the passages around the post's claims.
    if (url && cited && post) {
      const meta = this.read.get(normUrl(url));
      const base = { url, title: meta?.title ?? null, publishedAt: meta?.publishedAt ?? null, coverage };
      const grounding = groundingCheckOf(post.text, await this.textsRead(spec), dates);
      // The other pages the run read (one document under two addresses is one page).
      const seen = new Set([cited.text]);
      const others: SourcePage[] = [];
      for (const k of this.capture.keys()) {
        if (k === normUrl(url)) continue;
        const t = this.capture.readTextOf(k);
        if (!t || seen.has(t.text)) continue;
        seen.add(t.text);
        others.push({ url: this.read.get(k)?.url ?? k, text: t.text, title: this.read.get(k)?.title ?? null });
      }
      if (cited.coverage === 'full') {
        // The whole page is shown: passages only for what the other pages hold.
        return { ...base, excerpt: null, page: cited.text, passages: others.length ? sourcePassages(post.text, others, dates) : [], grounding };
      }
      if (cited.coverage === 'read') {
        const spans = cited.spans ?? [];
        const read = { size: cited.size, chars: cited.chars };
        if (cited.chars <= READ_DISPLAY_CAP) {
          return { ...base, excerpt: null, read: { ...read, spans }, passages: others.length ? sourcePassages(post.text, others, dates) : [], grounding };
        }
        // Too much to show whole: the passages around the post's claims in the parts read, then in the other pages.
        const asPages: SourcePage[] = spans.map((sp) => ({ url, text: sp.text, title: meta?.title ?? null }));
        const passages = sourcePassages(post.text, [...asPages, ...others], dates);
        return { ...base, excerpt: passages.length ? null : (spans[0]?.text ?? '').slice(0, READ_HEAD_CAP), read, passages, grounding };
      }
      const pages: SourcePage[] = [{ url, text: cited.text, title: meta?.title ?? null }, ...others];
      const passages = sourcePassages(post.text, pages, dates);
      return { ...base, excerpt: passages.length ? null : cited.text.slice(0, SOURCE_CAP), passages, grounding };
    }
    const excerpt = cited?.text ?? lib;
    if (!url && !excerpt) return null;
    const grounding = post ? groundingCheckOf(post.text, await this.textsRead(spec), dates) : null;
    return { url: url ?? ref, excerpt: excerpt ? excerpt.slice(0, SOURCE_CAP) : null, grounding, coverage };
  }

  /** Every text the run read (pages ≤ 60k, feed items' title + snippet) and the spec's library row, for grounding. */
  private async textsRead(spec: any): Promise<GroundingSource[]> {
    return (await this.groundingSources(spec)).filter((x) => typeof x.text === 'string' && x.text.trim()).map((x) => ({ url: x.url, text: x.text!, title: x.title ?? null }));
  }

  /** Spec 037 T5: the pages and feed items the run read, with their publication dates (lintPost's `ctx.sources`). */
  sources(): AuditSource[] {
    return [...this.read.values()];
  }

  /**
   * Spec 037 T4: `sources()` with the text the run read (≤ 60k chars a page, a feed item's title + snippet) and an
   * aggregator page's primary links, plus the library row behind the spec's `library_ref` — lintPost grounds the
   * post's numbers in them. T11: a page the run read also carries its main image (`image`, null = none); T17: and
   * every image of the page a news post may use (`images`, main first) when the tool listed them.
   */
  async groundingSources(spec?: { library_ref?: string | null } | null): Promise<AuditSource[]> {
    const out: AuditSource[] = this.sources().map((s) => {
      const text = this.capture.readTextOf(s.url)?.text;
      const primary = this.primary.get(normUrl(s.url));
      const image = this.images.has(normUrl(s.url)) ? { image: this.images.get(normUrl(s.url)) ?? null } : {};
      const images = this.pageImages.get(normUrl(s.url));
      return { ...s, ...(text ? { text } : {}), ...(primary ? { primaryLinks: primary } : {}), ...image, ...(images ? { images } : {}) };
    });
    const ref = typeof spec?.library_ref === 'string' ? spec.library_ref : null;
    if (ref && this.d.libraryText) {
      const text = await this.d.libraryText(ref).catch(() => null);
      if (text) out.push({ url: ref, text });
    }
    return out;
  }

  /** Spec 037 T11: the post's images for the critic (posters by name and use_for) and the source page's main image. */
  private media(spec: any) {
    const url: string | null = typeof spec?.source?.url === 'string' ? spec.source.url : null;
    return criticMediaOf(spec, url && this.images.has(normUrl(url)) ? this.images.get(normUrl(url)) ?? null : undefined,
      url ? this.pageImages.get(normUrl(url)) : undefined);
  }

  /**
   * Spec 037 T17: what the run read, as it is stored with the slot (`editor_slots.critic.sources`) — the post audit
   * and the approval card then see `image_not_from_source` / the source date without reading the page again.
   */
  storedSources(spec: unknown): StoredSource[] {
    const url = typeof (spec as any)?.source?.url === 'string' ? (spec as any).source.url as string : null;
    return storedSourcesOf(this.sources().map((s) => {
      const k = normUrl(s.url);
      return {
        ...s, ...(this.images.has(k) ? { image: this.images.get(k) ?? null } : {}),
        ...(this.pageImages.has(k) ? { images: this.pageImages.get(k)! } : {}),
      };
    }), url);
  }

  /** Spec 037 T5: the publish time and the source date for the critic's prompt; null without a publish time. */
  private dates(post: CriticPost): CriticDates | null {
    if (!post.publishAt || !post.timezone) return null;
    const url: string | null = typeof (post.spec as any)?.source?.url === 'string' ? (post.spec as any).source.url : null;
    const page = url ? this.read.get(normUrl(url))?.publishedAt ?? null : null;
    const fromUrl = url && !page ? dateFromUrl(url) : null;
    return {
      publishAt: post.publishAt, timezone: post.timezone,
      ...(page ? { sourcePublishedAt: page, sourceDateFrom: 'page' as const } : fromUrl ? { sourcePublishedAt: fromUrl, sourceDateFrom: 'url' as const } : {}),
      ...(post.story?.firstPostAt ? { storyFirstPostAt: post.story.firstPostAt } : {}),
    };
  }

  async check(post: CriticPost): Promise<CriticGateOutcome> {
    // Spec 037 T6: a broken character never reaches publish, whatever lint said (U+FFFD in the 11.10 Ledger post).
    const broken = findBrokenChars(post.text);
    if (broken.length) {
      return {
        kind: 'blocked',
        result: {
          error: 'text_replacement_char',
          details: `${broken.map((b) => `${brokenCharText(b.kind)}: «${b.excerpt}»`).join('; ')}. Перепиши ці слова звичайними літерами й виклич публікацію ще раз.`,
        },
      };
    }
    const hash = hashOf(post.spec);
    if (this.proceeded?.hash === hash) {
      return { kind: 'proceed', critic: this.proceeded.critic, ...(this.proceeded.edited ? { edited: this.proceeded.edited } : {}) };
    }

    const slop = slopCodes(post.warnings);
    const read = this.storedSources(post.spec);
    const withSources = read.length ? { sources: read } : {};
    const r = await this.d.critic.review({
      channelKey: this.c.channelKey, slotId: this.c.slotId, mode: this.c.mode, card: this.c.card ?? null,
      resourceRef: this.c.resourceRef, platform: this.c.platform, format: post.format, topic: this.c.topic, angle: this.c.angle,
      text: post.text, spec: post.spec, voice: this.c.voice, brief: this.c.brief, profile: this.c.profile,
      formatPrefs: this.c.formatPrefs, playbook: this.c.playbook, examples: this.c.examples ?? null, source: await this.source(post.spec, post),
      slopWarnings: post.warnings.filter((w) => slop.includes(w.code)).map((w) => ({ code: w.code, message: w.message })),
      lintWarnings: post.warnings.map((w) => ({ code: w.code, message: w.message })),
      previous: this.first, agent: this.c.agent ?? null, dates: this.dates(post),
      skills: this.c.skills ?? null,
      story: post.story ?? null,
      media: this.media(post.spec),
      ...(post.poster ? { posterDecision: post.poster } : {}),
      ownerRules: this.c.ownerRules ?? null,
      steering: this.c.steering ?? null,
      risk: draftRisk({ spec: post.spec, text: post.text, contentKind: this.c.voice?.style?.content_kind ?? null }),
      pinLevel: this.pinned(),
    });
    this.passes++;
    const history = this.first ? [{
      verdict: this.first.verdict, scores: this.first.scores, notes: this.first.notes, reason: this.first.reason, pass: this.first.pass, at: this.first.at,
      cost_usd: this.first.cost_usd, ...(this.first.route ? { route: this.first.route } : {}),
    }] : undefined;
    // Spec 041 FR-007: the critic's spend on this post across the passes of the run.
    this.spent += r.ok ? r.critic.cost_usd : r.costUsd;
    const lintCodes = [...new Set(post.warnings.map((w) => w.code))];
    const total = { cost_total_usd: Number(this.spent.toFixed(6)), ...(lintCodes.length ? { lint_warnings: lintCodes } : {}) };

    if (!r.ok) {
      const critic: StoredCritic = {
        verdict: 'error', scores: null, notes: `Критик не відповів: ${r.error}`, model_verdict: null, reason: r.error,
        pass: this.passes, slop_warnings: slop, model: null, run_id: r.runIds.at(-1) ?? null, cost_usd: Number(r.costUsd.toFixed(6)),
        at: new Date().toISOString(), ...(history ? { history } : {}), ...withSources, ...total,
      };
      if (this.c.mode === 'approve') {
        // The owner reviews every waiting post anyway: the card shows the critic error and is never auto-approved.
        return this.proceed(hash, critic);
      }
      await this.d.plans.updateSlot(this.c.slotId, { status: 'failed', error: `critic_failed: ${r.error}`.slice(0, 500), critic });
      await this.inbox(
        `Critic unavailable: a ${this.c.platform} post was held`,
        `The pre-publish critic did not answer for slot ${this.c.slotId} (${this.c.resourceRef}): ${r.error}. `
        + 'Nothing was published; the slot is marked failed. Check the critic model and the budget caps on /app/models and /app/spend.',
      );
      return { kind: 'halt', critic, result: { ok: true, failed: 'critic_failed', details: r.error } };
    }

    let critic: StoredCritic = { ...r.critic, ...(history ? { history } : {}), ...withSources, ...total };
    if (critic.verdict === 'pass') {
      const e = await this.edit(post, critic);
      if (!e.revise) return this.proceed(hash, e.critic, e.edited);
      critic = e.critic;
    }

    if (critic.verdict === 'revise' && this.passes < this.budget) return this.revise(critic);

    if (critic.verdict === 'revise' && this.c.mode === 'approve') {
      return this.proceed(hash, { ...critic, final: true });
    }

    // reject, or a second revise in live / shadow; spec 067 FR-004: with a budget of one pass the first revise is final too —
    // the verdict stays `revise` (the ladder's fixable classification still applies), the reason says no rewrite was left.
    const second = critic.verdict === 'revise';
    const capped = second && this.passes === 1;
    const stored: StoredCritic = second ? { ...critic, reason: `${capped ? 'cap_revise' : 'second_revise'}: ${critic.reason}` } : critic;
    await this.d.plans.updateSlot(this.c.slotId, {
      status: 'skipped', error: `critic_rejected: ${capped ? 'cap_revise — ' : second ? 'second revise — ' : ''}${criticLine(critic)}`.slice(0, 500), critic: stored,
    });
    return { kind: 'halt', critic: stored, result: { ok: true, skipped: true, critic_rejected: true, verdict: critic.verdict, notes: critic.notes } };
  }

  private async proceed(hash: string, critic: StoredCritic, edited?: EditedSpec): Promise<CriticGateOutcome> {
    await this.d.plans.updateSlot(this.c.slotId, { critic });
    this.proceeded = { hash, critic, ...(edited ? { edited } : {}) };
    return { kind: 'proceed', critic, ...(edited ? { edited } : {}) };
  }

  /** The first `revise`: the notes go back to the executor, which rewrites once in the same run. */
  private async revise(critic: StoredCritic): Promise<CriticGateOutcome> {
    this.first = critic;
    await this.d.plans.updateSlot(this.c.slotId, { critic });
    const after = this.c.mode === 'approve'
      ? 'Якщо й друга версія не пройде — пост піде власнику разом із цими зауваженнями.'
      : 'Друге «revise» пропускає слот.';
    // Spec 067 FR-002: the blocking issues (quote + fix) are what the second look checks, one by one.
    const blocking = (critic.issues ?? []).filter((i) => i.blocking).map((i) => ({ ...(i.quote ? { quote: i.quote } : {}), fix: i.fix, axis: i.axis }));
    return {
      kind: 'revise', critic,
      result: {
        error: 'critic_revise',
        details: {
          notes: critic.notes, scores: critic.scores, reason: critic.reason,
          ...(blocking.length ? { issues: blocking } : {}),
          ...(critic.edits_failed?.length ? { edits: critic.edits_failed.map((e) => ({ from: e.from, to: e.to })) } : {}),
          instruction: `Критик просить переписати пост. Виправ саме ці зауваження і виклич ${this.c.platform === 'telegram' ? 'publish_post' : 'publish_platform_post'} ще раз — це єдина спроба. ${after} Якщо пост не врятувати — skip_slot з причиною.`,
        },
        _grantSteps: CRITIC_REVISE_GRANT_STEPS,
      },
    };
  }

  /**
   * Spec 041 FR-002: a pass applies the critic's exact edits and the lint's euphony fixes to the spec, then the
   * publish tool's guards run again on it — no new LLM turn. A critic edit that does not match exactly once, or an
   * edited spec the guards refuse, turns the first pass into a `revise` (the notes name the edits); on a later pass
   * the post goes out as written and the failed edits are recorded. A lint fix that does not match is skipped.
   */
  private async edit(post: CriticPost, critic: StoredCritic): Promise<{ critic: StoredCritic; edited?: EditedSpec; revise?: true }> {
    // Spec 063 FR-004: the dash rule is code (never the model's edit); every edit is guarded against dropped words and
    // new language findings before it is applied. A refused edit is recorded and not retried through a revise.
    const proposedIn = critic.edits ?? [];
    const fixesIn = [...lintFixes(post.warnings), ...(post.warnings.some((w) => w.code === 'slop_em_dash') ? dashFixes(post.text) : [])];
    const guarded = guardEdits(post.text, [...proposedIn, ...fixesIn]);
    const safe = new Set<TextEdit>(guarded.ok);
    const proposed = proposedIn.filter((e) => safe.has(e));
    const fixes = fixesIn.filter((e) => safe.has(e));
    if (guarded.rejected.length) critic = { ...critic, edits_rejected: guarded.rejected };
    if (!post.relint || (!proposed.length && !fixes.length)) return { critic };
    const firstPass = this.passes < this.budget;
    const toRevise = (c: StoredCritic, why: string) => ({
      critic: {
        ...c, verdict: 'revise' as const, reason: why,
        notes: `${c.notes} Точкові правки не застосувались — внеси їх сам: ${(c.edits_failed ?? []).map((e) => `«${e.from}» → «${e.to}»`).join('; ')}`.slice(0, 1200),
      },
      revise: true as const,
    });
    const a = applySpecEdits(post.spec, proposed);
    const failedNote = a.failed.length ? { edits_failed: a.failed } : {};
    if (a.failed.length && firstPass) return toRevise({ ...critic, ...failedNote }, `edits_failed: ${a.failed.length}`);
    const b = applySpecEdits(a.spec, fixes);
    const applied = [...a.applied, ...b.applied];
    if (!applied.length) return { critic: { ...critic, ...failedNote } };
    const re = await post.relint(b.spec);
    if (!re.ok) {
      const all = [...a.failed, ...applied.map((e) => ({ ...e, found: 1 }))];
      if (firstPass) return toRevise({ ...critic, edits_failed: all }, `edits_lint: ${re.errors.join('; ')}`.slice(0, 300));
      return { critic: { ...critic, edits_failed: all } };
    }
    return { critic: { ...critic, edits_applied: applied, ...failedNote }, edited: { spec: b.spec, ...(re.state !== undefined ? { state: re.state } : {}) } };
  }

  private async inbox(title: string, body: string): Promise<void> {
    if (!this.d.inbox) return;
    try {
      await this.d.inbox({
        agentId: this.c.inboxAgentId ?? null, kind: 'critic_failed', severity: 'action', title, body, refType: 'slot', refId: this.c.slotId,
        alert: { title: `🧐 Критик не відповів — пост у ${this.c.resourceRef} не вийшов`, body: `Слот ${this.c.slotId}: ${body.slice(0, 300)}` },
      });
    } catch { /* the failed slot is what matters */ }
  }
}

/** A short summary for a publish tool's success result (the trace shows it next to the step). */
export function criticSummary(c: StoredCritic): Record<string, unknown> {
  return {
    verdict: c.verdict, scores: c.scores, notes: c.notes, pass: c.pass, ...(c.final ? { final: true } : {}),
    ...(c.edits_applied?.length ? { edits_applied: c.edits_applied } : {}),
    ...(c.edits_rejected?.length ? { edits_rejected: c.edits_rejected } : {}),
  };
}
