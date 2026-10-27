import { auditPostFromPlatformSpec } from '../audit/post-audit';
import { mediaCheck, posterDecisionOf, type PosterDecision } from '../post/integrity/checks/media';
import type { AuditCard, AuditSource } from '../post/integrity/types';
import type { PlatformLintIssue, PlatformPostSpec } from './platform-spec';

/**
 * Spec 037 T17: the T11 media rules on a native platform post before it is stored, sent or put up for approval —
 * `image_not_from_source` (a news image not from the source page the run read) and `poster_mismatch` (a network poster
 * on news or, spec 067, off topic: both errors here, since the executor can still fix them; the post audit of published
 * posts keeps the off-topic one a warning). Errors block like lint errors; warnings go to the critic. Without the source
 * page in `sources` the image rule says nothing (never guesses), as in lintPost. `poster` is the code's decision for the
 * critic (spec 067 A5), set whether or not the post has an image.
 */
export function platformMediaFindings(spec: PlatformPostSpec, i: {
  resourceRef: string;
  sources?:    AuditSource[];
  /** The resource style sheet (`content_kind` decides news vs explainer resources). */
  style?:      unknown;
  /** The planner's topic of a fixed slot (null for a live slot). */
  topic?:      string | null;
}): { errors: PlatformLintIssue[]; warnings: PlatformLintIssue[]; poster: PosterDecision } {
  const post = auditPostFromPlatformSpec(spec, {
    id: 'pending', channel: i.resourceRef, publishedAt: new Date().toISOString(), timezone: 'UTC', ...(i.topic?.trim() ? { topic: i.topic } : {}),
  });
  const style = i.style && typeof i.style === 'object' ? (i.style as AuditCard['style']) : undefined;
  const card = style ? { style } : undefined;
  const findings = mediaCheck.run(post, { previous: [], prePublish: true, ...(card ? { card } : {}), ...(i.sources?.length ? { sources: i.sources } : {}) });
  const issue = (f: { code: string; message: string }): PlatformLintIssue => ({ code: f.code, message: f.message });
  return {
    errors: findings.filter((f) => f.level === 'error').map(issue), warnings: findings.filter((f) => f.level !== 'error').map(issue),
    poster: posterDecisionOf(post, card),
  };
}
