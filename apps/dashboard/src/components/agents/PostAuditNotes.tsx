// Spec 037 FR-014 (T14): the post audit in Network health → resource → "Notes and
// sample posts". Issues grouped by code with counts; each group explains the rule
// and how to fix it and lists the posts (date, link to the Telegram post when it
// can be derived, the post's opening and the words the finding is about). Also the
// feed-fit list of spec 037 FR-009 (per feed: share of misfit items, suggestion).
// Everything wraps: no horizontal scroll at 375 px.

import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { describeError, toast } from '../ui/Toast';
import { fmtDate, fmtRelative } from '../../lib/format';
import { usePostAudit, useRunPostAudit } from '../../api/audit';
import {
  FEED_SUGGESTION_LABEL, findingLinks, groupCountLabel, type AuditCodeGroup, type AuditIssueItem, type AuditSummary, type FindingLevel,
} from '../../lib/audit-view';
import type { ResourceQuality } from '../../lib/quality-view';

const LEVEL_TONE: Record<FindingLevel, 'danger' | 'warning'> = { error: 'danger', warning: 'warning' };

const muted = { color: 'var(--color-ink-muted)' } as const;
const dim = { color: 'var(--color-ink-dim)' } as const;

/** Links and ids a check attached to a finding (story matches, earlier posts). */
export function FindingRefs({ extra }: { extra: Record<string, unknown> | null | undefined }) {
  const { links, ids } = findingLinks(extra);
  if (!links.length && !ids.length) return null;
  return (
    <div className="text-micro" style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 8px', minWidth: 0 }}>
      {links.map((l) => (
        <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="link-accent"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 3, minWidth: 0, overflowWrap: 'anywhere' }}>
          <Icon name="link" size={10} /> {l.label}
        </a>
      ))}
      {ids.map((id) => <span key={id} className="chip" style={{ fontSize: 10, overflowWrap: 'anywhere' }} title="Matched post id">{id}</span>)}
    </div>
  );
}

function IssueItem({ it }: { it: AuditIssueItem }) {
  return (
    <div style={{ padding: '6px 8px', borderRadius: 'var(--radius-sm)', background: 'var(--color-surface-2)', minWidth: 0, display: 'grid', gap: 3 }}>
      <div className="text-micro" style={{ ...dim, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 8px' }}>
        <span className="tabular-nums">{fmtDate(it.publishedAt)}</span>
        {it.format && <span>{it.format}</span>}
        {it.level === 'error' && <Badge tone="danger">error</Badge>}
        {it.url
          ? <a href={it.url} target="_blank" rel="noopener noreferrer" className="link-accent" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              Open post <Icon name="external" size={10} />
            </a>
          : <span title={it.slotId ?? it.postId}>no link</span>}
      </div>
      {it.postExcerpt && <div className="text-micro" style={{ color: 'var(--color-ink)', overflowWrap: 'anywhere' }}>{it.postExcerpt}</div>}
      {it.excerpt && (
        <div className="text-micro" style={{ ...muted, overflowWrap: 'anywhere', borderLeft: '2px solid var(--color-hairline)', paddingLeft: 6 }}>
          “{it.excerpt}”
        </div>
      )}
      <FindingRefs extra={it.extra} />
    </div>
  );
}

function CodeGroup({ g }: { g: AuditCodeGroup }) {
  return (
    <details style={{ minWidth: 0 }}>
      <summary style={{ cursor: 'pointer', listStyle: 'none', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>
        <Badge tone={LEVEL_TONE[g.level]}>{g.count}</Badge>
        <span className="text-micro" style={{ color: 'var(--color-ink)', fontWeight: 500, minWidth: 0, overflowWrap: 'anywhere' }}>{g.title}</span>
        <span className="text-micro" style={{ ...dim, marginLeft: 'auto' }}>{groupCountLabel(g)}</span>
      </summary>
      <div style={{ display: 'grid', gap: 5, padding: '5px 0 2px 4px', minWidth: 0 }}>
        <div className="text-micro" style={{ ...muted, overflowWrap: 'anywhere' }}>{g.explain}</div>
        <div className="text-micro" style={{ color: 'var(--color-ink)', overflowWrap: 'anywhere' }}>
          <span style={{ color: 'var(--color-accent)', fontWeight: 500 }}>How to fix:</span> {g.fix}
        </div>
        <div className="text-micro" style={{ ...dim, fontFamily: 'var(--font-mono, monospace)', fontSize: 10, overflowWrap: 'anywhere' }}>{g.code}</div>
        {g.items.map((it) => <IssueItem key={`${it.postKind}:${it.postId}:${it.excerpt ?? ''}`} it={it} />)}
        {g.count > g.items.length && <div className="text-micro" style={dim}>… and {g.count - g.items.length} more</div>}
      </div>
    </details>
  );
}

/** Spec 037 FR-014: one resource's audit, fetched when the notes are opened. */
export function PostAuditNotes({ resource, summary, open }: { resource: string; summary?: AuditSummary; open: boolean }) {
  const q = usePostAudit(resource, { enabled: open });
  const run = useRunPostAudit();
  const v = q.data;
  const rerun = () => run.mutate(resource, {
    onSuccess: (r) => {
      const res = r.results[0];
      if (res?.error) toast.error(`The audit failed: ${res.error}`);
      else toast.success(`Audited ${res?.posts ?? 0} post${res?.posts === 1 ? '' : 's'}: ${res?.findings ?? 0} finding${res?.findings === 1 ? '' : 's'}`);
    },
    onError: (e) => toast.error(describeError(e)),
  });
  return (
    <div data-testid="post-audit" style={{ display: 'grid', gap: 6, minWidth: 0 }}>
      <div className="text-micro" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', ...dim }}>
        <span style={{ textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 10 }}>Post audit</span>
        {v
          ? <span>{v.posts} post{v.posts === 1 ? '' : 's'} · {v.findings} finding{v.findings === 1 ? '' : 's'}{v.auditedAt ? ` · ${fmtRelative(v.auditedAt)}` : ''}</span>
          : summary ? <span>{summary.findings} finding{summary.findings === 1 ? '' : 's'}</span> : null}
        {v && !v.current && v.auditedAt && <Badge tone="warning" title="The rules changed since the last run; the next run recomputes the last 7 days">rules changed</Badge>}
        <button type="button" className="btn-tiny" disabled={run.isPending} onClick={rerun} style={{ marginLeft: 'auto', gap: 4 }} title="Run the checks over the last 7 days now">
          <Icon name="refresh" size={11} /> {run.isPending ? 'Running…' : 'Run now'}
        </button>
      </div>
      {q.error && <div className="callout-danger"><span className="text-micro">{describeError(q.error)}</span></div>}
      {!v && !q.error && open && <div style={{ height: 40, borderRadius: 'var(--radius-sm)', background: 'var(--color-surface-2)', opacity: 0.6 }} />}
      {v?.error && <div className="text-micro" style={{ color: 'var(--color-danger)', overflowWrap: 'anywhere' }}>Last run failed: {v.error}</div>}
      {v && !v.auditedAt && <div className="text-micro" style={dim}>Not audited yet. The audit runs daily; use Run now to check the last 7 days.</div>}
      {v && v.auditedAt && v.groups.length === 0 && (
        <div className="text-micro" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--color-success)' }}>
          <Icon name="check" size={11} /> No issues in the posts of the last {v.days} days.
        </div>
      )}
      {v?.groups.map((g) => <CodeGroup key={g.code} g={g} />)}
    </div>
  );
}

/** Spec 037 FR-009: how each feed of the resource fits its audience (from the MANAGER digest). */
export function FeedFitList({ feeds }: { feeds: NonNullable<ResourceQuality['feeds']> }) {
  if (!feeds.length) return null;
  return (
    <div data-testid="feed-fit" style={{ display: 'grid', gap: 4, minWidth: 0 }}>
      <div className="text-micro" style={{ ...dim, textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 10 }}
        title="Per feed: items with unexplained jargon over the audience level, or a critic revise / reject">
        Feed fit
      </div>
      {feeds.map((f) => (
        <div key={f.feed} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '2px 8px', alignItems: 'center', minWidth: 0 }}>
          <span className="text-micro" style={{ color: 'var(--color-ink)', overflowWrap: 'anywhere', minWidth: 0 }}>{f.feed}</span>
          <span className="text-micro tabular-nums" style={{ color: f.suggestion ? 'var(--color-danger)' : 'var(--color-ink-muted)', textAlign: 'right' }}
            title={`${f.items} items: ${f.jargon_over_level} with jargon over the level, ${f.revise} revise, ${f.reject} reject`}>
            {Math.round(f.misfit_share * 100)}% of {f.items} off
          </span>
          {f.suggestion && (
            <span style={{ gridColumn: '1 / -1' }}><Badge tone={f.suggestion === 'replace' ? 'danger' : 'warning'}>{FEED_SUGGESTION_LABEL[f.suggestion]}</Badge></span>
          )}
        </div>
      ))}
    </div>
  );
}
