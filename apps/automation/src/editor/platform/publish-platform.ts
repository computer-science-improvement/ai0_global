import { parseResourceRef, Platform } from '../agents/agent.types';
import type { ResourceHealth } from '../agents/resource-profile';
import { similarity } from '../post/similarity';
import { checkVerbatim } from '../post/verbatim-guard';
import type { PostSpec } from '../post/post-spec';
import type { VoicePrefs } from '../post/slop-lint';
import type { PreparedPublish } from '../publish/prepare-media';
import { CAPABILITIES } from './capabilities';
import { captionPlain, lintPlatformPost, PlatformLintResult, PlatformPostSpec, renderPlatform, RenderedPlatformPost } from './platform-spec';
import type { PlatformPostsRepository } from './platform-posts.repository';
import type { ResourcePublisher } from './resource-publisher';

/** The same idea is a repeat on a resource within this window. Sources go through the content ledger (023 FR-010). */
export const PLATFORM_IDEA_DEDUP_DAYS = 7;
export const PLATFORM_SIMILARITY_LIMIT = 0.6;
/** Spec 024 FR-013: a hint for the agents, no longer a code rule (only the platform API caps are). */
export const PLATFORM_GAP_HINT_MIN = 60;

export interface PublishPlatformDeps {
  posts:     Pick<PlatformPostsRepository, 'insert' | 'alreadyPosted' | 'countPublishedSince' | 'lastPostAt' | 'recentCaptions'>
    & Partial<Pick<PlatformPostsRepository, 'settle'>>;
  publisher: Pick<ResourcePublisher, 'publish'>;
  /** Render + host slides (live only). */
  hostSlides?: (slides: NonNullable<PlatformPostSpec['slides']>, key: { channelKey: string; slotId: string }) => Promise<PreparedPublish>;
  health:    (resourceRef: string) => Promise<ResourceHealth | null>;
  /** The verbatim-copy guard reads the library and fetched sources (spec 004). */
  pool?:     Parameters<typeof checkVerbatim>[0];
  recordPublish?: (throttleKey: string) => void;
  now?:      () => Date;
}

export interface PublishPlatformInput {
  resourceRef:  string;
  spec:         PlatformPostSpec;
  mode:         'shadow' | 'approve' | 'live';
  slotId?:      string | null;
  agentId?:     string | null;
  /** Playbook limits for this resource (020); the matrix cap applies regardless. */
  maxPerDay?:   number | null;
  vocabulary?:  string[];
  bannedTerms?: string[];
  /** Spec 034: format_prefs humor / slang / emoji of the resource (slop warnings only). */
  voice?: VoicePrefs | null;
}

export type PublishPlatformResult =
  | {
      ok: true; shadow: boolean; postId: number; externalId: string | null; url: string | null; preview: string; warnings: string[]; lint: PlatformLintResult;
      /** Spec 031: written and waiting for the owner; `rendered` is exactly what will be sent. */
      awaiting?: boolean; rendered?: RenderedPlatformPost;
    }
  | { error: string; details?: unknown };

const BLOCKING_HEALTH = new Set(['no_access', 'token_invalid']);

/**
 * The one live path for native platform posts (spec 019 FR-007), shared by the
 * platform executor and the scheduled path. Shadow mode renders and records,
 * never calls a platform API.
 */
export async function publishPlatformNow(d: PublishPlatformDeps, i: PublishPlatformInput): Promise<PublishPlatformResult> {
  const now = (d.now ?? (() => new Date()))();
  const ref = parseResourceRef(i.resourceRef);
  if (!ref || ref.platform === 'telegram') return { error: 'not_a_platform_resource', details: 'Telegram публікується через publish_post' };
  const platform = ref.platform as Exclude<Platform, 'telegram'>;

  const lint = lintPlatformPost(i.spec, { platform, bannedTerms: i.bannedTerms, vocabulary: i.vocabulary, voice: i.voice });
  if (!lint.ok) return { error: 'lint_failed', details: lint.errors };

  const health = await d.health(i.resourceRef);
  if (health && BLOCKING_HEALTH.has(health.state)) return { error: 'resource_unavailable', details: `${health.state}: ${health.detail ?? ''}` };

  if (d.pool) {
    // The guard compares the reader-visible text (caption + slides) with the library row behind library_ref.
    const text = [i.spec.caption, ...(i.spec.slides ?? []).map((sl) => `${sl.title} ${sl.text}`)].filter(Boolean).join('\n') || i.spec.title;
    const verbatim = await checkVerbatim(d.pool, {
      format: 'text', title: i.spec.title, origin: 'library', body: [{ type: 'p', text: text.slice(0, 1500) }],
      media: [], placement: 'above', hashtags: [], buttons: [], library_ref: i.spec.library_ref,
    } as PostSpec);
    if (verbatim) return verbatim;
  }

  const sourceRef = i.spec.library_ref ?? i.spec.source?.url ?? null;
  const since = new Date(now.getTime() - PLATFORM_IDEA_DEDUP_DAYS * 86_400_000);
  // Approval mode also counts posts that already wait (spec 031), so two waiting posts never share a source.
  const waiting = i.mode === 'approve';
  const secondRef = i.spec.library_ref && i.spec.source?.url ? i.spec.source.url : null;
  if (await d.posts.alreadyPosted(i.resourceRef, { source: sourceRef, ideaId: i.spec.idea_id ?? null }, since, waiting)
    || (secondRef && await d.posts.alreadyPosted(i.resourceRef, { source: secondRef }, since, waiting))) {
    return { error: 'already_posted', details: 'це джерело вже використане на цьому ресурсі (журнал контенту) або ця ідея вже виходила тут за 7 днів' };
  }
  const caption = captionPlain(i.spec, CAPABILITIES[platform].linksClickable);
  const recent = await d.posts.recentCaptions(i.resourceRef, 40, waiting);
  const maxSim = recent.reduce((m, t) => Math.max(m, similarity(caption, t)), 0);
  if (caption.length > 40 && maxSim >= PLATFORM_SIMILARITY_LIMIT) {
    return { error: 'too_similar', details: `схожість ${maxSim.toFixed(2)} з нещодавнім постом цього ресурсу` };
  }

  const preview = renderPlatform(i.spec, platform);
  if (i.mode === 'approve') {
    // Spec 031 FR-004: every check of a live publish ran above; slides are rendered and hosted now so the
    // owner approves exactly what goes out. Nothing is sent — publishApprovedPlatform does that after approval.
    let prepared: PreparedPublish | null = null;
    try {
      if (i.spec.slides?.length) {
        if (!d.hostSlides) return { error: 'slides_unavailable', details: 'рендер слайдів не налаштований' };
        prepared = await d.hostSlides(i.spec.slides, { channelKey: i.resourceRef, slotId: i.slotId ?? `now-${now.getTime()}` });
      }
    } catch (err: any) {
      return { error: 'prepare_failed', details: String(err?.message ?? err).slice(0, 1000) };
    }
    const rendered = renderPlatform(i.spec, platform, prepared?.prepared.slideUrls ?? []);
    const row = await d.posts.insert({
      resourceRef: i.resourceRef, platform, slotId: i.slotId ?? null, ideaId: i.spec.idea_id ?? null, format: i.spec.format,
      caption: rendered.caption, spec: i.spec, sourceRef, status: 'awaiting_approval', agentId: i.agentId ?? null,
    });
    return {
      ok: true, shadow: false, awaiting: true, postId: row.id, externalId: null, url: null, preview: rendered.caption, rendered,
      warnings: lint.warnings.map((w) => w.message), lint,
    };
  }
  if (i.mode !== 'live') {
    const row = await d.posts.insert({
      resourceRef: i.resourceRef, platform, slotId: i.slotId ?? null, ideaId: i.spec.idea_id ?? null, format: i.spec.format,
      caption: preview.caption, spec: i.spec, sourceRef, status: 'shadowed', agentId: i.agentId ?? null,
    });
    return { ok: true, shadow: true, postId: row.id, externalId: null, url: null, preview: preview.caption, warnings: lint.warnings.map((w) => w.message), lint };
  }

  // Live only from here.
  const dayStart = new Date(now.getTime() - 24 * 3600_000);
  const cap = Math.min(CAPABILITIES[platform].dailyApiCap, i.maxPerDay ?? Number.POSITIVE_INFINITY);
  const done = await d.posts.countPublishedSince(i.resourceRef, dayStart);
  if (done >= cap) return { error: 'daily_cap_reached', details: `${done}/${cap} за 24 год` };

  let prepared: PreparedPublish | null = null;
  try {
    if (i.spec.slides?.length) {
      if (!d.hostSlides) return { error: 'slides_unavailable', details: 'рендер слайдів не налаштований' };
      prepared = await d.hostSlides(i.spec.slides, { channelKey: i.resourceRef, slotId: i.slotId ?? `now-${now.getTime()}` });
    }
    const rendered = renderPlatform(i.spec, platform, prepared?.prepared.slideUrls ?? []);
    let published;
    try {
      published = await d.publisher.publish(i.resourceRef, rendered);
    } catch (err: any) {
      const msg = String(err?.message ?? err).slice(0, 1000);
      await d.posts.insert({
        resourceRef: i.resourceRef, platform, slotId: i.slotId ?? null, ideaId: i.spec.idea_id ?? null, format: i.spec.format,
        caption: rendered.caption, spec: i.spec, sourceRef, status: 'failed', error: msg, agentId: i.agentId ?? null,
      });
      return { error: 'publish_failed', details: msg };
    }
    const row = await d.posts.insert({
      resourceRef: i.resourceRef, platform, externalId: published.externalId, url: published.url, slotId: i.slotId ?? null,
      ideaId: i.spec.idea_id ?? null, format: i.spec.format, caption: rendered.caption, spec: i.spec, sourceRef, status: 'published', agentId: i.agentId ?? null,
    });
    try { d.recordPublish?.(`${platform}:${ref.id}`); } catch { /* throttle bookkeeping only */ }
    return {
      ok: true, shadow: false, postId: row.id, externalId: published.externalId, url: published.url, preview: rendered.caption,
      warnings: [...lint.warnings.map((w) => w.message), ...published.warnings], lint,
    };
  } catch (err: any) {
    return { error: 'publish_failed', details: String(err?.message ?? err).slice(0, 1000) };
  } finally {
    if (prepared) await prepared.cleanup();
  }
}

export interface ApprovedPlatformInput {
  resourceRef: string;
  /** The waiting platform_posts row written in approval mode. */
  postId:      number;
  spec:        PlatformPostSpec;
  /** Exactly what the owner approved (stored on the slot). */
  rendered:    RenderedPlatformPost;
  maxPerDay?:  number | null;
}

export type ApprovedPlatformResult =
  | { ok: true; externalId: string | null; url: string | null; warnings: string[] }
  | { error: 'dedup_after_approval' | 'daily_cap_reached' | 'resource_unavailable' | 'publish_failed' | 'not_a_platform_resource'; details?: string };

/**
 * Spec 031: publish a post the owner approved, at its time. Re-runs the
 * checks that can change while a post waits (resource health, dedup, the
 * daily cap) and sends the stored render unchanged.
 */
export async function publishApprovedPlatform(d: PublishPlatformDeps, i: ApprovedPlatformInput): Promise<ApprovedPlatformResult> {
  const now = (d.now ?? (() => new Date()))();
  const ref = parseResourceRef(i.resourceRef);
  if (!ref || ref.platform === 'telegram') return { error: 'not_a_platform_resource' };
  const platform = ref.platform as Exclude<Platform, 'telegram'>;
  const settle = async (status: 'published' | 'failed' | 'canceled', p: { externalId?: string | null; url?: string | null; error?: string | null } = {}) => {
    try { await d.posts.settle?.(i.postId, status, p); } catch { /* the slot row is what the owner sees */ }
  };

  const health = await d.health(i.resourceRef);
  if (health && BLOCKING_HEALTH.has(health.state)) return { error: 'resource_unavailable', details: `${health.state}: ${health.detail ?? ''}` };

  const sourceRef = i.spec.library_ref ?? i.spec.source?.url ?? null;
  const since = new Date(now.getTime() - PLATFORM_IDEA_DEDUP_DAYS * 86_400_000);
  const recent = await d.posts.recentCaptions(i.resourceRef);
  const maxSim = recent.reduce((m, t) => Math.max(m, similarity(i.rendered.caption, t)), 0);
  if (await d.posts.alreadyPosted(i.resourceRef, { source: sourceRef, ideaId: i.spec.idea_id ?? null }, since)
    || (i.rendered.caption.length > 40 && maxSim >= PLATFORM_SIMILARITY_LIMIT)) {
    await settle('canceled', { error: 'dedup_after_approval' });
    return { error: 'dedup_after_approval', details: 'за час очікування схоже джерело / ідея вже вийшли на цьому ресурсі' };
  }
  const cap = Math.min(CAPABILITIES[platform].dailyApiCap, i.maxPerDay ?? Number.POSITIVE_INFINITY);
  const done = await d.posts.countPublishedSince(i.resourceRef, new Date(now.getTime() - 24 * 3600_000));
  if (done >= cap) return { error: 'daily_cap_reached', details: `${done}/${cap} за 24 год` };

  try {
    const published = await d.publisher.publish(i.resourceRef, i.rendered);
    await settle('published', { externalId: published.externalId, url: published.url });
    try { d.recordPublish?.(`${platform}:${ref.id}`); } catch { /* throttle bookkeeping only */ }
    return { ok: true, externalId: published.externalId, url: published.url, warnings: published.warnings };
  } catch (err: any) {
    const msg = String(err?.message ?? err).slice(0, 1000);
    await settle('failed', { error: msg });
    return { error: 'publish_failed', details: msg };
  }
}
