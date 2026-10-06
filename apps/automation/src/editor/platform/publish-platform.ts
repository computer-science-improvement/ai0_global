import { parseResourceRef, Platform } from '../agents/agent.types';
import type { ResourceHealth } from '../agents/resource-profile';
import { similarity } from '../post/similarity';
import { checkVerbatim } from '../post/verbatim-guard';
import type { PostSpec } from '../post/post-spec';
import type { PreparedPublish } from '../publish/prepare-media';
import { CAPABILITIES } from './capabilities';
import { captionPlain, lintPlatformPost, PlatformLintResult, PlatformPostSpec, renderPlatform } from './platform-spec';
import type { PlatformPostsRepository } from './platform-posts.repository';
import type { ResourcePublisher } from './resource-publisher';

export const PLATFORM_DEDUP_DAYS = 7;
export const PLATFORM_SIMILARITY_LIMIT = 0.6;
export const PLATFORM_MIN_GAP_MIN = 60;

export interface PublishPlatformDeps {
  posts:     Pick<PlatformPostsRepository, 'insert' | 'alreadyPosted' | 'countPublishedSince' | 'lastPostAt' | 'recentCaptions'>;
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
}

export type PublishPlatformResult =
  | { ok: true; shadow: boolean; postId: number; externalId: string | null; url: string | null; preview: string; warnings: string[]; lint: PlatformLintResult }
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

  const lint = lintPlatformPost(i.spec, { platform, bannedTerms: i.bannedTerms, vocabulary: i.vocabulary });
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
  const since = new Date(now.getTime() - PLATFORM_DEDUP_DAYS * 86_400_000);
  if (await d.posts.alreadyPosted(i.resourceRef, { source: sourceRef, ideaId: i.spec.idea_id ?? null }, since)) {
    return { error: 'already_posted', details: 'це джерело / ідея вже були на цьому ресурсі за 7 днів' };
  }
  const caption = captionPlain(i.spec, CAPABILITIES[platform].linksClickable);
  const recent = await d.posts.recentCaptions(i.resourceRef);
  const maxSim = recent.reduce((m, t) => Math.max(m, similarity(caption, t)), 0);
  if (caption.length > 40 && maxSim >= PLATFORM_SIMILARITY_LIMIT) {
    return { error: 'too_similar', details: `схожість ${maxSim.toFixed(2)} з нещодавнім постом цього ресурсу` };
  }

  const preview = renderPlatform(i.spec, platform);
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
  const last = await d.posts.lastPostAt(i.resourceRef);
  if (last && now.getTime() - last.getTime() < PLATFORM_MIN_GAP_MIN * 60_000) {
    return { error: 'min_gap', details: `останній пост ${Math.round((now.getTime() - last.getTime()) / 60_000)} хв тому` };
  }

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
