import type { Pool } from 'pg';
import { PostSpecSchema } from '../post/post-spec';
import { auditPostFromSpec } from '../post/integrity/from-post-spec';
import { INTEGRITY_CHECKS, runIntegrityChecks } from '../post/integrity/registry';
import type { AuditContext, AuditPost, Finding } from '../post/integrity/types';
import { recentAuditPosts } from '../post/variety/recent-posts';
import { StoryRegistry } from '../story/story.repository';
import { PlatformPostSpecSchema } from '../platform/platform-spec';
import { auditPostFromPlatformSpec, findingExtra, parseSources } from './post-audit';
import { catalogueEntry, type AuditFlag, type FindingSection } from './code-catalogue';
import type { ResourceAuditCard } from './post-audit.service';

/**
 * Spec 037 FR-014 (T14): what the owner sees on an approval card before approving — every deterministic check over
 * the waiting post, with the resource's recent posts as history (story matches, monotony) and the sources when the
 * slot stored them: lint warnings, numbers without a source (T4; until then what lint gives), story matches with
 * the links / ids a check attaches, the date checks. Each finding carries the English catalogue text and the
 * card section it belongs to. The stored `lintWarnings` stay as they are; this list is additive.
 */

export interface ApprovalFinding {
  code:     string;
  level:    'error' | 'warning';
  /** The check's own words (the agents' language). */
  message:  string;
  excerpt:  string | null;
  title:    string;
  explain:  string;
  fix:      string;
  section:  FindingSection;
  group:    AuditFlag | null;
  /** Links or ids of matched posts and anything else a check adds. */
  extra:    Record<string, unknown> | null;
}

const SECTION_ORDER: Record<FindingSection, number> = { stories: 0, facts: 1, dates: 2, lint: 3 };

/** Findings → the card's list: sections in order, errors first inside a section. */
export function toApprovalFindings(findings: Finding[]): ApprovalFinding[] {
  const seen = new Set<string>();
  const out: ApprovalFinding[] = [];
  for (const f of findings) {
    const key = `${f.code}|${f.message}|${f.excerpt ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const e = catalogueEntry(f.code);
    out.push({
      code: f.code, level: f.level === 'error' ? 'error' : 'warning', message: f.message, excerpt: f.excerpt ?? null,
      title: e.title, explain: e.explain, fix: e.fix, section: e.section, group: e.group, extra: findingExtra(f),
    });
  }
  return out.sort((a, b) => SECTION_ORDER[a.section] - SECTION_ORDER[b.section] || (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
}

/** The waiting slot as the integrity checks read it (null: no spec, or a spec of neither shape). */
export function approvalAuditPost(i: {
  id: string; channelKey: string; resourceRef: string; scheduledAt: Date; timezone: string; postSpec: unknown; topic?: string | null;
  topicMode?: string | null; render?: ResourceAuditCard['render'];
}): AuditPost | null {
  const meta = { id: i.id, channel: i.resourceRef, publishedAt: i.scheduledAt.toISOString(), timezone: i.timezone };
  if (i.resourceRef.startsWith('telegram:')) {
    const spec = PostSpecSchema.safeParse(i.postSpec);
    if (!spec.success) return null;
    return auditPostFromSpec(spec.data, {
      ...meta, card: i.render, ...(i.topicMode !== 'live' && i.topic?.trim() ? { topic: i.topic } : {}),
    });
  }
  const spec = PlatformPostSpecSchema.safeParse(i.postSpec);
  return spec.success ? auditPostFromPlatformSpec(spec.data, meta) : null;
}

export interface ApprovalFindingsDeps {
  pool:    Pick<Pool, 'query'>;
  cardOf?: (ref: string) => Promise<ResourceAuditCard | null>;
}

/** The approval service's `findings` hook: never throws (a failure is an empty list). */
export function approvalFindingsHook(d: ApprovalFindingsDeps) {
  return async (item: {
    id: string; channelKey: string; resourceRef?: string | null; scheduledAt: Date; timezone: string; postSpec?: unknown;
    topic?: string; topicMode?: string | null; renderMessages?: unknown;
  }): Promise<ApprovalFinding[]> => {
    try {
      if (!item.postSpec || (item.renderMessages as { kind?: string } | null)?.kind === 'forward') return [];
      const ref = item.resourceRef ?? `telegram:${item.channelKey}`;
      const own = d.cardOf ? await d.cardOf(ref).catch(() => null) : null;
      const card = { ...own?.card, timezone: own?.card.timezone ?? item.timezone };
      const post = approvalAuditPost({
        id: item.id, channelKey: item.channelKey, resourceRef: ref, scheduledAt: item.scheduledAt, timezone: item.timezone,
        postSpec: item.postSpec, topic: item.topic, topicMode: item.topicMode, render: own?.render,
      });
      if (!post) return [];
      const previous = ref.startsWith('telegram:')
        ? (await recentAuditPosts(d.pool, { channelKey: item.channelKey, timezone: item.timezone, excludeSlotId: item.id, card: own?.render, limit: 60 }).catch(() => []))
          .filter((p) => Date.parse(p.publishedAt) <= Date.parse(post.publishedAt))
        : [];
      const { rows } = await d.pool.query(
        `SELECT COALESCE(to_jsonb(s) -> 'sources', s.critic -> 'sources') AS sources FROM editor_slots s WHERE s.id = $1`, [item.id],
      ).catch(() => ({ rows: [] as any[] }));
      const sources = parseSources(rows[0]?.sources);
      // Spec 037 T2: the sibling channels' posts near this one, as the story guard reads them (story_cross_channel).
      const network = ref.startsWith('telegram:')
        ? (await new StoryRegistry(d.pool).history(item.channelKey, item.id, new Date(post.publishedAt)).catch(() => null))?.network ?? []
        : [];
      const ctx: AuditContext = { previous, network, card, now: post.publishedAt, ...(sources ? { sources } : {}) };
      return toApprovalFindings(runIntegrityChecks(post, ctx, INTEGRITY_CHECKS));
    } catch {
      return [];
    }
  };
}
