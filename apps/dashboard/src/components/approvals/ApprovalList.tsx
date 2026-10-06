// «Пости на апрув» (spec 031): waiting and approved posts grouped by resource
// and day, with «Апрувнути все» per resource-day and per network-day (posts
// with lint warnings are never bulk-approved). Used on the Inbox page, the
// agent page and in the agent chat.

import { Fragment, useMemo } from 'react';
import { EmptyState } from '../ui/primitives';
import { Icon } from '../ui/Icon';
import { toast, describeError } from '../ui/Toast';
import { ApprovalCard } from './ApprovalCard';
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

function ukPosts(n: number): string {
  const d = n % 10, dd = n % 100;
  return d === 1 && dd !== 11 ? 'пост' : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? 'пости' : 'постів';
}

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
      const parts = [`Апрувнуто ${r.approved} ${ukPosts(r.approved)} (${label})`];
      if (r.skippedWithWarnings) parts.push(`${r.skippedWithWarnings} з попередженнями — перегляньте окремо`);
      if (r.conflicts) parts.push(`${r.conflicts} вже вирішено`);
      toast.success(parts.join('; '));
    },
    onError: (e) => toast.error(describeError(e)),
  });

  if (q.error) return <div className="callout-danger">{describeError(q.error)}</div>;
  if (!q.data) return <div className="panel compose-rise" style={{ height: 120, opacity: 0.55 }} />;
  if (!items.length) {
    return <EmptyState icon="check" title="Нічого не чекає апруву"
      note={emptyNote ?? 'Ресурси в режимі «На апруві» пишуть пости заздалегідь (наступний день — о 20:00), і кожен зʼявляється тут до публікації.'} />;
  }

  let lastNetworkDay = '';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {groups.map((g) => {
        const waiting = g.items.filter((i) => i.status === 'awaiting_approval');
        const clean = waiting.filter((i) => !i.lintWarnings.length).length;
        const nk = `${g.channelKey}|${g.day}`;
        const showNetwork = (networkDays.get(nk)?.size ?? 0) > 1 && nk !== lastNetworkDay;
        if (showNetwork) lastNetworkDay = nk;
        return (
          <Fragment key={g.key}>
            {showNetwork && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 12px', background: 'var(--color-surface-1)', border: '1px solid var(--color-hairline-soft)', borderRadius: 'var(--radius-md)' }}>
                <span className="text-body-sm" style={{ flex: '1 1 220px' }}>Мережа {g.title} · {fmtDay(g.day)}: пости на кількох ресурсах</span>
                <button className="btn-secondary" disabled={bulk.isPending} onClick={() => approveAll({ channel: g.channelKey, date: g.day }, `мережа ${g.title}, ${fmtDay(g.day)}`)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Icon name="check" size={14} /> Апрувнути все в мережі на {fmtDay(g.day)}
                </button>
              </div>
            )}
            <section>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
                <div style={{ minWidth: 0, flex: '1 1 200px' }}>
                  <div className="text-body-sm" style={{ color: 'var(--color-ink)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {g.title}{g.resourceRef !== `telegram:${g.channelKey}` ? ` · ${g.resourceRef}` : ''}
                  </div>
                  <div className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>
                    {fmtDay(g.day)} · {waiting.length} чекає{g.items.length > waiting.length ? ` · ${g.items.length - waiting.length} апрувнуто` : ''}
                  </div>
                </div>
                {waiting.length > 0 && (
                  <button className="btn-primary" disabled={bulk.isPending || clean === 0}
                    title={clean === 0 ? 'Усі пости з попередженнями — апрувніть їх окремо' : undefined}
                    onClick={() => approveAll({ resource: g.resourceRef, date: g.day }, `${g.title}, ${fmtDay(g.day)}`)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Icon name="check" size={14} /> Апрувнути все на {fmtDay(g.day)}{clean < waiting.length ? ` (${clean})` : ''}
                  </button>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 380px), 1fr))', gap: 12, alignItems: 'start' }}>
                {g.items.map((it, i) => <ApprovalCard key={it.id} item={it} delay={Math.min(i, 10) * 30} />)}
              </div>
            </section>
          </Fragment>
        );
      })}
    </div>
  );
}
