import type { Pool } from 'pg';
import { z } from 'zod';
import { defineTool, EditorTool, ToolContext } from '../harness/tool';
import { parseResourceRef, Platform } from '../agents/agent.types';
import type { EditorPlansRepository } from '../repo/editor-plans.repository';
import { AgentPlatformPostSpecSchema, lintPlatformPost, renderPlatform } from './platform-spec';
import type { VoicePrefs } from '../post/slop-lint';
import { publishPlatformNow, PublishPlatformDeps } from './publish-platform';
import { freshnessDeadline } from '../approval/approval-timing';
import { criticGateOf, criticSummary, PUBLISH_TOOL_TIMEOUT_MS } from '../critic/critic-gate';
import type { ScheduleService } from '../schedule/schedule.service';

/** Per-run data of a platform slot (put into ctx.extras by the runner, spec 019/020). */
export interface PlatformSlotExtras {
  resourceRef: string;
  mode:        'shadow' | 'approve' | 'live';
  maxPerDay?:  number | null;
  vocabulary?: string[];
  bannedTerms?: string[];
  agentId?:    string | null;
  /** Spec 034: the target's format_prefs humor / slang / emoji (slop warnings). */
  voice?:      VoicePrefs | null;
}

export interface PlatformToolDeps {
  pool:    Pick<Pool, 'query'>;
  publish: PublishPlatformDeps;
  plans:   Pick<EditorPlansRepository, 'getSlot' | 'updateSlot'>;
  notifyPreview?: (resourceRef: string, text: string) => Promise<void>;
  /** Spec 023 FR-004/FR-005: blackout (live) and required series source guards. */
  schedule?: Pick<ScheduleService, 'publishGuard'>;
}

function slotOf(ctx: ToolContext): PlatformSlotExtras | null {
  return (ctx.extras?.platformSlot as PlatformSlotExtras | undefined) ?? null;
}

const READ_ROLES = ['planner', 'executor', 'reviewer', 'composer', 'orchestrator', 'idea_reviewer', 'manager'] as const;

/**
 * Executor tools for non-Telegram slots and the platform read tools (spec 019
 * FR-008 / FR-010). The publish tool is the slot's terminal action.
 */
export function buildPlatformTools(d: PlatformToolDeps): EditorTool[] {
  const lintPlatform = defineTool({
    name: 'lint_platform_post',
    description: 'Перевірити нативний пост для Instagram / Facebook / Threads / TikTok перед публікацією: ліміти підпису, хештеги, посилання, кількість медіа, формат. Повертає помилки й превʼю підпису.',
    kind: 'read', roles: ['executor', 'composer'],
    input: z.object({ resource: z.string().min(3).max(200).optional().describe('ref ресурсу; у слоті — береться зі слота'), spec: AgentPlatformPostSpecSchema }),
    execute: async ({ resource, spec }, ctx) => {
      const ref = resource ?? slotOf(ctx)?.resourceRef;
      const p = ref ? parseResourceRef(ref) : null;
      if (!p || p.platform === 'telegram') return { error: 'not_a_platform_resource' };
      const platform = p.platform as Exclude<Platform, 'telegram'>;
      const lint = lintPlatformPost(spec, { platform, bannedTerms: slotOf(ctx)?.bannedTerms, vocabulary: slotOf(ctx)?.vocabulary, voice: slotOf(ctx)?.voice });
      return { ...lint, preview: renderPlatform(spec, platform).caption };
    },
  });

  const publishPlatform = defineTool({
    name: 'publish_platform_post',
    description: 'Опублікувати нативний пост у ресурс слота (Instagram / Facebook / Threads / TikTok) — завершує роботу. Перед збереженням пост читає критик: critic_revise — виправ зауваження й виклич ще раз (одна спроба). У shadow-режимі лише зберігає превʼю; у режимі апруву пост готується повністю і чекає схвалення власника. Перед цим lint_platform_post.',
    kind: 'terminal', roles: ['executor'], timeoutMs: PUBLISH_TOOL_TIMEOUT_MS,
    input: z.object({ spec: AgentPlatformPostSpecSchema }),
    execute: async ({ spec }, ctx) => {
      const slot = slotOf(ctx);
      if (!slot || !ctx.slotId) return { error: 'no_platform_slot', details: 'цей прогін не має слота іншої платформи' };
      const s = await d.plans.getSlot(ctx.slotId);
      if (!s || s.status !== 'running') return { error: 'slot_not_running' };
      if (d.schedule) {
        const card = (ctx.extras?.card as { sources?: any[] } | undefined) ?? null;
        const sg = await d.schedule.publishGuard(s, { libraryRef: spec.library_ref, sourceUrl: spec.source?.url }, { live: slot.mode === 'live', now: new Date(), feeds: card?.sources ?? [] });
        if (sg) return sg;
      }
      // Spec 034 FR-004: the critic reads the post after every check, before it is stored, sent or put up for approval.
      const gate = criticGateOf(ctx);
      let critic = null as Record<string, unknown> | null;
      const r = await publishPlatformNow(d.publish, {
        resourceRef: slot.resourceRef, spec, mode: slot.mode, slotId: ctx.slotId, agentId: slot.agentId ?? null,
        maxPerDay: slot.maxPerDay, vocabulary: slot.vocabulary, bannedTerms: slot.bannedTerms, voice: slot.voice,
        ...(gate ? {
          review: async ({ text, lint }) => {
            const c = await gate.check({ text, spec, format: spec.format, warnings: lint.warnings });
            if (c.kind !== 'proceed') return { halt: c.result };
            critic = criticSummary(c.critic);
            return null;
          },
        } : {}),
      });
      if ('error' in r) return r;
      if ('halted' in r) return r.halted;
      const withCritic = critic ? { critic } : {};
      if (r.awaiting && r.rendered) {
        // Spec 031: written and waiting; the approval publisher sends `rendered` after the owner approves.
        const card = ctx.extras?.card as { sources?: unknown } | undefined;
        await d.plans.updateSlot(ctx.slotId, {
          status: 'awaiting_approval', postSpec: spec, renderedPreview: r.preview, error: null,
          renderMessages: { kind: 'platform', platform: parseResourceRef(slot.resourceRef)!.platform, rendered: r.rendered as unknown as Record<string, unknown> },
          platformPostId: r.postId, lintWarnings: r.warnings,
          freshnessDeadline: card?.sources ? freshnessDeadline(s, card as any) : null,
        });
        return { ok: true, awaiting_approval: true, warnings: r.warnings, ...withCritic };
      }
      await d.plans.updateSlot(ctx.slotId, {
        // Spec 024: the spec stays on the slot — a derived (duplicate / adapt) slot reads its source from here.
        status: r.shadow ? 'shadowed' : 'published', postSpec: spec, renderedPreview: r.preview, error: r.warnings.length ? r.warnings.join(' | ').slice(0, 2000) : null,
      });
      if (r.shadow && d.notifyPreview) {
        try { await d.notifyPreview(slot.resourceRef, r.preview); } catch { /* best-effort */ }
      }
      return { ok: true, shadow: r.shadow, external_id: r.externalId, url: r.url, warnings: r.warnings, ...withCritic };
    },
  });

  const platformStats = defineTool({
    name: 'get_platform_stats',
    description: 'Статистика ресурсу будь-якої платформи за N днів (дні — у часовому поясі ресурсу): підписники по днях, пости з переглядами/охопленням і залученістю, середні по форматах.',
    kind: 'read', roles: [...READ_ROLES],
    input: z.object({ resource: z.string().min(3).max(200), days: z.number().int().min(1).max(90).default(28) }),
    execute: async ({ resource, days }) => {
      const { rows: daily } = await d.pool.query(
        `SELECT day::text, followers, followers_delta, reach, views, engagement FROM resource_daily_stats
          WHERE resource_ref = $1 AND day >= (now() AT TIME ZONE resource_tz($1))::date - $2::int ORDER BY day`, [resource, days]);
      const { rows: formats } = await d.pool.query(
        `SELECT format, COUNT(*)::int AS posts, ROUND(AVG(views))::int AS avg_views, ROUND(AVG(engagement))::int AS avg_engagement
           FROM network_posts WHERE resource_ref = $1 AND posted_at >= now() - ($2 || ' days')::interval GROUP BY format ORDER BY avg_views DESC NULLS LAST`,
        [resource, String(days)]);
      return { resource, days, daily, formats };
    },
  });

  const networkPosts = defineTool({
    name: 'get_network_posts',
    description: 'Пости мережі на всіх платформах (Telegram + інші) за N днів: ресурс, формат, уривок, перегляди, залученість. Фільтр за ресурсом або групою.',
    kind: 'read', roles: [...READ_ROLES],
    input: z.object({
      resource: z.string().max(200).optional(),
      network:  z.string().uuid().optional().describe('id мережі (групи акаунтів)'),
      days:     z.number().int().min(1).max(60).default(14),
      limit:    z.number().int().min(1).max(100).default(40),
    }),
    execute: async ({ resource, network, days, limit }) => {
      const { rows } = await d.pool.query(
        `SELECT np.resource_ref, np.platform, np.format, np.excerpt, np.posted_at, np.views, np.engagement, np.post_ref
           FROM network_posts np
          WHERE np.posted_at >= now() - ($1 || ' days')::interval
            AND ($2::text IS NULL OR np.resource_ref = $2)
            AND ($3::uuid IS NULL OR np.resource_ref IN (
                  SELECT 'telegram:' || channel_key FROM tracked_channels WHERE group_id = $3 AND channel_key IS NOT NULL
                  UNION SELECT platform || ':' || id FROM meta_accounts WHERE group_id = $3
                  UNION SELECT 'tiktok:' || id FROM tiktok_accounts WHERE group_id = $3))
          ORDER BY np.posted_at DESC LIMIT $4`,
        [String(days), resource ?? null, network ?? null, limit]);
      // Spec 024: post_ref names a repurpose_post source (tg:<id> → published_post_id, pp:<id> → platform_post_id).
      return {
        posts: rows.map(({ post_ref, ...r }) => ({
          ...r,
          ...(typeof post_ref === 'string' && post_ref.startsWith('tg:') ? { published_post_id: Number(post_ref.slice(3)) } : {}),
          ...(typeof post_ref === 'string' && post_ref.startsWith('pp:') ? { platform_post_id: Number(post_ref.slice(3)) } : {}),
        })),
      };
    },
  });

  return [lintPlatform, publishPlatform, platformStats, networkPosts];
}
