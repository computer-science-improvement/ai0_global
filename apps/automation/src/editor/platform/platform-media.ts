import { auditPostFromPlatformSpec } from '../audit/post-audit';
import { mediaCheck } from '../post/integrity/checks/media';
import type { AuditCard, AuditSource } from '../post/integrity/types';
import type { PlatformLintIssue, PlatformPostSpec } from './platform-spec';

/**
 * Spec 037 T17: the T11 media rules on a native platform post before it is stored, sent or put up for approval —
 * `image_not_from_source` (a news image not from the source page the run read) and `poster_mismatch` (a network poster
 * on news: error; off topic: warning). Errors block like lint errors; warnings go to the critic. Without the source
 * page in `sources` the image rule says nothing (never guesses), as in lintPost.
 */
export function platformMediaFindings(spec: PlatformPostSpec, i: {
  resourceRef: string;
  sources?:    AuditSource[];
  /** The resource style sheet (`content_kind` decides news vs explainer resources). */
  style?:      unknown;
  /** The planner's topic of a fixed slot (null for a live slot). */
  topic?:      string | null;
}): { errors: PlatformLintIssue[]; warnings: PlatformLintIssue[] } {
  const post = auditPostFromPlatformSpec(spec, {
    id: 'pending', channel: i.resourceRef, publishedAt: new Date().toISOString(), timezone: 'UTC', ...(i.topic?.trim() ? { topic: i.topic } : {}),
  });
  const style = i.style && typeof i.style === 'object' ? (i.style as AuditCard['style']) : undefined;
  const findings = mediaCheck.run(post, { previous: [], ...(style ? { card: { style } } : {}), ...(i.sources?.length ? { sources: i.sources } : {}) });
  const issue = (f: { code: string; message: string }): PlatformLintIssue => ({ code: f.code, message: f.message });
  return { errors: findings.filter((f) => f.level === 'error').map(issue), warnings: findings.filter((f) => f.level !== 'error').map(issue) };
}
