// "Posts to approve" (spec 031): waiting and approved posts grouped by resource
// and day, with "Approve all" per resource-day and per network-day (posts
// with lint warnings are never bulk-approved). Used on the Inbox page, the
// agent page and in the agent chat.
// Spec 078 D4: a group is a titled block (resource, day, counts) over a compact-grid of cards; "Approve all" is a quiet
// secondary button (the one main action is Approve in a post's dialog). Styles: approvals.css (appr-).

import { Fragment, useMemo } from 'react';
import { EmptyState } from '../ui/primitives';
import { Icon } from '../ui/Icon';
import { toast, describeError } from '../ui/Toast';
import { ApprovalCard } from './ApprovalCard';
import { heldByCritic } from '../../lib/critic';
import { fmtDay, useApprovals, useBulkApprove, type ApprovalCardData, type ApprovalFilter } from '../../api/approvals';

interface Group { key: string; channelKey: string; resourceRef: string; title: string; day: string; items: ApprovalCardData[] }

function groupOf(items: ApprovalCardData[]): Group[] {
  const m = new Map<string, Group>();
  for (const it of items) {
    const key = `${it.resourceRef}|${it.planDate}`;
    const g = m.get(key) ?? { key, channelKey: it.channelKey, resourceRef: it.resourceRef, title: it.channelTitle || it.channelKey, day: it.planDate, items: [] };
    g.items.push(it);
    m.set(key, g);
  }
  return [...m.values()].sort((a, b) => a.day.localeCompare(b.day) || a.channelKey.localeCompare(b.channelKey) || a.resourceRef.localeCompare(b.resourceRef));
}

const posts = (n: number) => `${n} ${n === 1 ? 'post' : 'posts'}`;

export function ApprovalList({ filter = {}, emptyNote, limit }: { filter?: ApprovalFilter; emptyNote?: string; limit?: number }) {
  const q = useApprovals({ ...filter, status: ['awaiting_approval', 'approved'] });
  const bulk = useBulkApprove();
  const items = q.data?.items ?? [];
  const groups = useMemo(() => groupOf(limit ? items.slice(0, limit) : items), [items, limit]);
  // Networks with more than one resource waiting on the same day get a network-wide button too.
  const networkDays = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const g of groups) if (g.items.some((i) => i.status === 'awaiting_approval')) {
      const k = `${g.channelKey}|${g.day}`;
      m.set(k, (m.get(k) ?? new Set()).add(g.resourceRef));
    }
    return m;
  }, [groups]);

  const approveAll = (body: { channel?: string; resource?: string; date: string }, label: string) => bulk.mutate(body, {
    onSuccess: (r) => {
      const parts = [`Approved ${posts(r.approved)} (${label})`];
      if (r.skippedWithWarnings) parts.push(`${r.skippedWithWarnings} with warnings or critic notes — review them one by one`);
      if (r.conflicts) parts.push(`${r.conflicts} already decided`);
      toast.success(parts.join('; '));
    },
    onError: (e) => toast.error(describeError(e)),
  });

  if (q.error) return <div className="callout-danger" role="alert">{describeError(q.error)}</div>;
  if (!q.data) return <div className="appr-skeleton" aria-busy="true" />;
  if (!items.length) {
    return <EmptyState tone="clear" title="Nothing awaiting approval"
      note={emptyNote ?? 'Resources in approval mode write posts in advance (the next day at 20:00), and each one appears here before it is published.'} />;
  }

  let lastNetworkDay = '';
  return (
    <div className="appr-list">
      {groups.map((g) => {
        const waiting = g.items.filter((i) => i.status === 'awaiting_approval');
        // Posts with lint warnings or a critic verdict other than pass are decided one by one (spec 034 FR-004).
        const clean = waiting.filter((i) => !i.lintWarnings.length && !heldByCritic(i.critic)).length;
        const nk = `${g.channelKey}|${g.day}`;
        const showNetwork = (networkDays.get(nk)?.size ?? 0) > 1 && nk !== lastNetworkDay;
        if (showNetwork) lastNetworkDay = nk;
        return (
          <Fragment key={g.key}>
            {showNetwork && (
              <div className="inset appr-network">
                <span className="text-body-sm appr-network-text">Network {g.title} · {fmtDay(g.day)}: posts on several resources</span>
                <button className="btn-secondary btn-sm" disabled={bulk.isPending} onClick={() => approveAll({ channel: g.channelKey, date: g.day }, `network ${g.title}, ${fmtDay(g.day)}`)}>
                  <Icon name="check" size={14} /> Approve all in the network for {fmtDay(g.day)}
                </button>
              </div>
            )}
            <section className="appr-group" aria-label={`${g.title}, ${fmtDay(g.day)}`}>
              <div className="appr-group-head">
                <div className="appr-group-title">
                  <h3 className="text-heading-md appr-group-name">
                    {g.title}{g.resourceRef !== `telegram:${g.channelKey}` ? <span className="mono appr-group-ref"> · {g.resourceRef}</span> : ''}
                  </h3>
                  <div className="text-micro mono appr-dim">
                    {fmtDay(g.day)} · {waiting.length} waiting{g.items.length > waiting.length ? ` · ${g.items.length - waiting.length} approved` : ''}
                  </div>
                </div>
                {waiting.length > 0 && (
                  <button className="btn-secondary btn-sm" disabled={bulk.isPending || clean === 0}
                    title={clean === 0 ? 'Every post has warnings — approve them one by one' : undefined}
                    onClick={() => approveAll({ resource: g.resourceRef, date: g.day }, `${g.title}, ${fmtDay(g.day)}`)}>
                    <Icon name="check" size={14} /> Approve all for {fmtDay(g.day)}{clean < waiting.length ? ` (${clean})` : ''}
                  </button>
                )}
              </div>
              <div className="compact-grid">
                {g.items.map((it, i) => <ApprovalCard key={it.id} item={it} delay={Math.min(i, 10) * 30} />)}
              </div>
            </section>
          </Fragment>
        );
      })}
    </div>
  );
}
