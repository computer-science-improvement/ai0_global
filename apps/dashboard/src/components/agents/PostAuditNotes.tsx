// Spec 037 FR-014 (T14): the post audit in Network health → resource → "Notes and
// sample posts". Issues grouped by code with counts; each group explains the rule
// and how to fix it and lists the posts (date, link to the Telegram post when it
// can be derived, the post's opening and the words the finding is about). Also the
// feed-fit list of spec 037 FR-009 (per feed: share of misfit items, suggestion).
// Everything wraps: no horizontal scroll at 375 px.
// Spec 078 D3: classes (amg-* in agent-manager.css), the group keeps its <details> disclosure; codes are mono.

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

/** Links and ids a check attached to a finding (story matches, earlier posts). */
export function FindingRefs({ extra }: { extra: Record<string, unknown> | null | undefined }) {
  const { links, ids } = findingLinks(extra);
  if (!links.length && !ids.length) return null;
  return (
    <div className="text-micro amg-refs">
      {links.map((l) => (
        <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="link-accent amg-ref">
          <Icon name="link" size={12} /> {l.label}
        </a>
      ))}
      {ids.map((id) => <span key={id} className="chip mono amg-wrap" title="Matched post id">{id}</span>)}
    </div>
  );
}

function IssueItem({ it }: { it: AuditIssueItem }) {
  return (
    <div className="amg-issue">
      <div className="text-micro amg-dim amg-issue-head">
        <span className="mono tabular-nums">{fmtDate(it.publishedAt)}</span>
        {it.format && <span className="mono">{it.format}</span>}
        {it.level === 'error' && <Badge tone="danger">error</Badge>}
        {it.url
          ? <a href={it.url} target="_blank" rel="noopener noreferrer" className="link-accent amg-ref">
              Open post <Icon name="external" size={12} />
            </a>
          : <span title={it.slotId ?? it.postId}>no link</span>}
      </div>
      {it.postExcerpt && <div className="text-micro amg-ink amg-wrap">{it.postExcerpt}</div>}
      {it.excerpt && <div className="text-micro amg-muted amg-wrap amg-quote">“{it.excerpt}”</div>}
      <FindingRefs extra={it.extra} />
    </div>
  );
}

function CodeGroup({ g }: { g: AuditCodeGroup }) {
  return (
    <details className="amg-codegroup">
      <summary className="amg-sum">
        <span className="amg-chev" aria-hidden><Icon name="chevron-right" size={12} /></span>
        <Badge tone={LEVEL_TONE[g.level]}><span className="mono tabular-nums">{g.count}</span></Badge>
        <span className="text-micro amg-ink amg-wrap amg-sum-title">{g.title}</span>
        <span className="text-micro amg-dim amg-push">{groupCountLabel(g)}</span>
      </summary>
      <div className="amg-codegroup-body">
        <div className="text-micro amg-muted amg-wrap">{g.explain}</div>
        <div className="text-micro amg-ink amg-wrap">
          <span className="amg-fixlabel">How to fix:</span> {g.fix}
        </div>
        <div className="mono amg-code amg-wrap">{g.code}</div>
        {g.items.map((it) => <IssueItem key={`${it.postKind}:${it.postId}:${it.excerpt ?? ''}`} it={it} />)}
        {g.count > g.items.length && <div className="text-micro amg-dim">… and {g.count - g.items.length} more</div>}
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
    <div data-testid="post-audit" className="amg-audit">
      <div className="amg-audit-head">
        <span className="text-overline">Post audit</span>
        {v
          ? <span className="amg-count">{v.posts} post{v.posts === 1 ? '' : 's'} · {v.findings} finding{v.findings === 1 ? '' : 's'}{v.auditedAt ? ` · ${fmtRelative(v.auditedAt)}` : ''}</span>
          : summary ? <span className="amg-count">{summary.findings} finding{summary.findings === 1 ? '' : 's'}</span> : null}
        {v && !v.current && v.auditedAt && <Badge tone="warning" title="The rules changed since the last run; the next run recomputes the last 7 days">rules changed</Badge>}
        <button type="button" className="btn-tiny amg-push" disabled={run.isPending} onClick={rerun} title="Run the checks over the last 7 days now">
          <Icon name="refresh" size={12} /> {run.isPending ? 'Running…' : 'Run now'}
        </button>
      </div>
      {q.error && <div className="callout-danger"><span className="text-micro">{describeError(q.error)}</span></div>}
      {!v && !q.error && open && <div className="amg-skeleton is-line" aria-hidden />}
      {v?.error && <div className="text-micro amg-danger amg-wrap">Last run failed: {v.error}</div>}
      {v && !v.auditedAt && <div className="text-micro amg-dim">Not audited yet. The audit runs daily; use Run now to check the last 7 days.</div>}
      {v && v.auditedAt && v.groups.length === 0 && (
        <div className="text-micro amg-ok amg-inline">
          <Icon name="check" size={12} /> No issues in the posts of the last {v.days} days.
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
    <div data-testid="feed-fit" className="amg-feeds">
      <div className="text-overline" title="Per feed: items with unexplained jargon over the audience level, or a critic revise / reject">
        Feed fit
      </div>
      {feeds.map((f) => (
        <div key={f.feed} className="amg-feed">
          <span className="text-micro amg-ink amg-wrap">{f.feed}</span>
          <span className={`text-micro mono tabular-nums amg-feed-share${f.suggestion ? ' is-bad' : ''}`}
            title={`${f.items} items: ${f.jargon_over_level} with jargon over the level, ${f.revise} revise, ${f.reject} reject`}>
            {Math.round(f.misfit_share * 100)}% of {f.items} off
          </span>
          {f.suggestion && (
            <span className="amg-feed-badge"><Badge tone={f.suggestion === 'replace' ? 'danger' : 'warning'}>{FEED_SUGGESTION_LABEL[f.suggestion]}</Badge></span>
          )}
        </div>
      ))}
    </div>
  );
}
