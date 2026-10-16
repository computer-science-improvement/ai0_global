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
import { groundingCheckOf } from './critic-passages';
import { criticMediaOf } from './critic-media';
import { storedSourcesOf, type StoredSource } from './stored-sources';
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
  warnings: ReadonlyArray<{ code: string; message: string }>;
  /** Spec 037 T5: the (scheduled) publish instant and the resource zone, for the critic's date line. */
  publishAt?: string;
  timezone?:  string;
  /** Spec 037 T2: the story's earlier posts (the story guard), null for a new story. */
  story?:     CriticStoryContext | null;
}

/**
 * The gate's answer to a publish tool:
 * - `proceed`: store / publish / create the approval card (the verdict is already on the slot);
 * - `revise`: return `result` (a tool error with the notes) — the executor rewrites once;
 * - `halt`: the slot is already `skipped` (reject) or `failed` (critic error); return `result` to end the run;
 * - `blocked`: the text has a broken character (spec 037 T6) — return `result`, the executor rewrites the word; the
 *   critic is not called and nothing is stored.
 */
export type CriticGateOutcome =
  | { kind: 'proceed'; critic: StoredCritic }
  | { kind: 'blocked'; result: ToolError }
  | { kind: 'revise'; critic: StoredCritic; result: ToolError & { _grantSteps: number } }
  | { kind: 'halt'; critic: StoredCritic; result: Record<string, unknown> };

export interface CriticGateDeps {
  critic: Pick<CriticService, 'review'>;
  plans:  Pick<EditorPlansRepository, 'updateSlot'>;
  inbox?: (i: InboxItemInput) => Promise<unknown>;
  /** Text of a library / data row behind `library_ref` (the critic's source excerpt). */
  libraryText?: (ref: string) => Promise<string | null>;
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
  card?:        { models?: Partial<Record<EditorRole, string>>; dailyBudgetUsd?: number | null } | null;
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
}

const SOURCE_CAP = 4_000;
/** Spec 037 T4: a page read in the run is kept whole (up to this), for grounding and the critic's passages. */
export const PAGE_CAP = 60_000;

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
 * - revise (first pass) → a `critic_revise` tool error with the notes; the
 *   executor rewrites exactly once in the same run (the loop grants 2 turns);
 * - revise (second pass) → live / shadow: rejected; approval: proceeds to the
 *   owner with the notes on the card (`final: true`);
 * - reject → the slot is skipped (`critic_rejected: …`);
 * - critic error / timeout / blocking cap (after one retry) → live / shadow:
 *   the slot fails with an Inbox entry, nothing is published; approval: the
 *   card is created with `verdict: 'error'` (the owner decides; never auto-approved).
 *
 * The verdict, scores and notes are written to `editor_slots.critic`.
 */
export class CriticGate {
  private passes = 0;
  private first: StoredCritic | null = null;
  /** The spec that already proceeded: a retry of the same post after a later error is not reviewed again. */
  private proceeded: { hash: string; critic: StoredCritic } | null = null;
  private readonly fetched = new Map<string, string>();
  /** Spec 037 T5: what the run read, with the publication date when the page or the feed item gave one. */
  private readonly read = new Map<string, AuditSource>();
  /** Spec 037 T4: an aggregator page's links to the primary source (web_fetch `primary_links`). */
  private readonly primary = new Map<string, string[]>();
  /** Spec 037 T11: the main image of each page read (web_fetch `image`, extract_images `og_image`); null = none. */
  private readonly images = new Map<string, string | null>();
  /** Spec 037 T17: every image of each page read a news post may use (web_fetch / extract_images `images`). */
  private readonly pageImages = new Map<string, string[]>();

  constructor(private readonly d: CriticGateDeps, readonly c: CriticGateContext) {}

  /** Wrap the run's read tools so the critic sees the source text the executor read (web_fetch, fetch_feed). */
  wrapTools(tools: EditorTool[]): EditorTool[] {
    return tools.map((t) => {
      if (t.name !== 'web_fetch' && t.name !== 'fetch_feed' && t.name !== 'extract_images') return t;
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
    if (tool === 'web_fetch') {
      const text = [out?.title, out?.description, out?.text].filter((x) => typeof x === 'string' && x.trim()).join('\n');
      for (const u of [input?.url, out?.url]) if (typeof u === 'string' && text) this.fetched.set(normUrl(u), text.slice(0, PAGE_CAP));
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
      if (text && !this.fetched.has(normUrl(it.link))) this.fetched.set(normUrl(it.link), text.slice(0, PAGE_CAP));
    }
  }

  /** Spec 037 T17: the page's main image and its article images (≤ 10, main first); nothing when the tool gave no list. */
  private rememberImages(url: string, main: unknown, list: unknown): void {
    if (!Array.isArray(list)) return;
    const all = [...(typeof main === 'string' ? [main] : []), ...list.filter((x): x is string => typeof x === 'string' && /^https?:\/\//i.test(x))];
    this.pageImages.set(normUrl(url), [...new Set(all)].slice(0, 10));
  }

  private async source(spec: any, post?: CriticPost): Promise<CriticRequest['source']> {
    const url: string | null = typeof spec?.source?.url === 'string' ? spec.source.url : null;
    // Spec 037 T4: a page the run read gives the critic its title, date and the passages around the post's claims.
    const page = url ? this.fetched.get(normUrl(url)) : undefined;
    if (url && page && post) {
      const meta = this.read.get(normUrl(url));
      const pages: SourcePage[] = [{ url, text: page, title: meta?.title ?? null },
        ...[...this.fetched.entries()].filter(([k]) => k !== normUrl(url)).map(([k, text]) => ({ url: this.read.get(k)?.url ?? k, text, title: this.read.get(k)?.title ?? null }))];
      const passages = sourcePassages(post.text, pages, { publishedAt: post.publishAt, timezone: post.timezone });
      const grounding = groundingCheckOf(post.text, await this.textsRead(spec), { publishedAt: post.publishAt, timezone: post.timezone });
      return { url, excerpt: passages.length ? null : page.slice(0, SOURCE_CAP), title: meta?.title ?? null, publishedAt: meta?.publishedAt ?? null, passages, grounding };
    }
    let excerpt = url ? this.fetched.get(normUrl(url)) ?? null : null;
    if (!excerpt && typeof spec?.library_ref === 'string' && this.d.libraryText) {
      excerpt = await this.d.libraryText(spec.library_ref).catch(() => null);
    }
    if (!url && !excerpt) return null;
    const grounding = post ? groundingCheckOf(post.text, await this.textsRead(spec), { publishedAt: post.publishAt, timezone: post.timezone }) : null;
    return { url: url ?? (typeof spec?.library_ref === 'string' ? spec.library_ref : null), excerpt: excerpt ? excerpt.slice(0, SOURCE_CAP) : null, grounding };
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
      const text = this.fetched.get(normUrl(s.url));
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
    if (this.proceeded?.hash === hash) return { kind: 'proceed', critic: this.proceeded.critic };

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
      ownerRules: this.c.ownerRules ?? null,
    });
    this.passes++;
    const history = this.first ? [{
      verdict: this.first.verdict, scores: this.first.scores, notes: this.first.notes, reason: this.first.reason, pass: this.first.pass, at: this.first.at,
    }] : undefined;

    if (!r.ok) {
      const critic: StoredCritic = {
        verdict: 'error', scores: null, notes: `Критик не відповів: ${r.error}`, model_verdict: null, reason: r.error,
        pass: this.passes, slop_warnings: slop, model: null, run_id: r.runIds.at(-1) ?? null, cost_usd: Number(r.costUsd.toFixed(6)),
        at: new Date().toISOString(), ...(history ? { history } : {}), ...withSources,
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

    const critic: StoredCritic = { ...r.critic, ...(history ? { history } : {}), ...withSources };
    if (critic.verdict === 'pass') return this.proceed(hash, critic);

    if (critic.verdict === 'revise' && this.passes === 1) {
      this.first = critic;
      await this.d.plans.updateSlot(this.c.slotId, { critic });
      const after = this.c.mode === 'approve'
        ? 'Якщо й друга версія не пройде — пост піде власнику разом із цими зауваженнями.'
        : 'Друге «revise» пропускає слот.';
      return {
        kind: 'revise', critic,
        result: {
          error: 'critic_revise',
          details: {
            notes: critic.notes, scores: critic.scores, reason: critic.reason,
            instruction: `Критик просить переписати пост. Виправ саме ці зауваження і виклич ${this.c.platform === 'telegram' ? 'publish_post' : 'publish_platform_post'} ще раз — це єдина спроба. ${after} Якщо пост не врятувати — skip_slot з причиною.`,
          },
          _grantSteps: CRITIC_REVISE_GRANT_STEPS,
        },
      };
    }

    if (critic.verdict === 'revise' && this.c.mode === 'approve') {
      return this.proceed(hash, { ...critic, final: true });
    }

    // reject, or a second revise in live / shadow.
    const second = critic.verdict === 'revise';
    const stored: StoredCritic = second ? { ...critic, reason: `second_revise: ${critic.reason}` } : critic;
    await this.d.plans.updateSlot(this.c.slotId, {
      status: 'skipped', error: `critic_rejected: ${second ? 'second revise — ' : ''}${criticLine(critic)}`.slice(0, 500), critic: stored,
    });
    return { kind: 'halt', critic: stored, result: { ok: true, skipped: true, critic_rejected: true, verdict: critic.verdict, notes: critic.notes } };
  }

  private async proceed(hash: string, critic: StoredCritic): Promise<CriticGateOutcome> {
    await this.d.plans.updateSlot(this.c.slotId, { critic });
    this.proceeded = { hash, critic };
    return { kind: 'proceed', critic };
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
  return { verdict: c.verdict, scores: c.scores, notes: c.notes, pass: c.pass, ...(c.final ? { final: true } : {}) };
}
