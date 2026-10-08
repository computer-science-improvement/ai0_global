// Ideas tab of /app/agents/$handle (spec 020 FR-011): the network's idea pool
// with status filters (counts from one fetch), per idea the angle, variants per
// platform, sources, why, the reviewer's five scores and comment, expiry, and
// the owner override (accept / reject) while the idea is not final, and — once
// planned — the per-resource decision matrix (spec 024 FR-011).

import { useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { RowActions, TableAction } from '../ui/table';
import { useConfirm } from '../ui/ConfirmDialog';
import { toast } from '../ui/Toast';
import { SegmentedTabs } from '../SegmentedTabs';
import { fmtDate } from '../../lib/format';
import { useDecideIdea, useIdeas, type IdeaRow, type IdeaStatus } from '../../api/network';
import { DecisionRows } from './AgentPlan';
import { IDEA_STATUS_LABEL, IDEA_TONE, NetworkError, ORIGIN_LABEL, ResourceChip, ScoreMeter, errorText, fmtExpires } from './NetworkUi';

export type IdeaFilter = 'accepted' | 'new' | 'needs_revision' | 'planned' | 'used' | 'rejected' | 'all';

const FILTERS: Array<{ key: IdeaFilter; label: string }> = [
  { key: 'accepted', label: 'Accepted' },
  { key: 'new', label: 'New' },
  { key: 'needs_revision', label: 'Needs revision' },
  { key: 'planned', label: 'Planned' },
  { key: 'used', label: 'Used' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'all', label: 'All' },
];

const DECIDABLE: IdeaStatus[] = ['new', 'needs_revision', 'accepted', 'rejected'];

const SCORES = [
  { key: 'fit', label: 'fit', title: 'Fit with the network' },
  { key: 'novelty', label: 'novelty', title: 'Novelty' },
  { key: 'verifiability', label: 'verifiable', title: 'Verifiability' },
  { key: 'platform_fit', label: 'platform', title: 'Platform fit' },
  { key: 'risk', label: 'safety', title: 'Risk (5 = safe)' },
] as const;

const VERDICT_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = { accept: 'success', revise: 'warning', reject: 'danger' };

export function AgentIdeas({ handle, focus }: { handle: string; focus?: string }) {
  const q = useIdeas(handle, null);
  const [filter, setFilter] = useState<IdeaFilter>(focus ? 'all' : 'accepted');
  useEffect(() => { if (focus) setFilter('all'); }, [focus]);

  const ideas = useMemo(() => q.data?.ideas ?? [], [q.data]);
  const counts = useMemo(() => {
    const c: Partial<Record<IdeaStatus, number>> = {};
    for (const i of ideas) c[i.status] = (c[i.status] ?? 0) + 1;
    return c;
  }, [ideas]);
  const shown = filter === 'all' ? ideas : ideas.filter((i) => i.status === filter);

  if (q.error) return <NetworkError error={q.error} />;

  const options = FILTERS.map((f) => {
    const n = f.key === 'all' ? ideas.length : counts[f.key] ?? 0;
    return { key: f.key, label: q.data ? `${f.label} · ${n}` : f.label };
  });

  return (
    <div>
      <div style={{ marginBottom: 14, maxWidth: '100%' }}>
        <SegmentedTabs size="sm" value={filter} onChange={setFilter} options={options} />
      </div>
      {!q.data && <div className="panel compose-rise" style={{ height: 140, opacity: 0.55 }} />}
      {q.data && shown.length === 0 && (
        <div>
          <EmptyState icon="sparkles" title={filter === 'all' ? 'The idea pool is empty' : `No ${IDEA_STATUS_LABEL[filter as IdeaStatus]} ideas`}
            note="The orchestrator adds ideas from sources, series and directives; the idea reviewer scores them before the planner may use them." />
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {shown.map((idea, i) => <IdeaCard key={idea.id} idea={idea} delay={Math.min(i, 12) * 25} focused={idea.id === focus} />)}
      </div>
    </div>
  );
}

function host(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; }
}

function IdeaCard({ idea, delay, focused }: { idea: IdeaRow; delay: number; focused: boolean }) {
  const confirm = useConfirm();
  const decide = useDecideIdea();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focused]);

  const canDecide = DECIDABLE.includes(idea.status);
  const r = idea.review;
  const act = async (decision: 'accept' | 'reject') => {
    if (decision === 'reject' && !(await confirm(`reject the idea «${idea.title}»`, { confirmLabel: 'Reject' }))) return;
    decide.mutate({ id: idea.id, decision }, {
      onSuccess: () => toast.success(decision === 'accept' ? 'Idea accepted' : 'Idea rejected'),
      onError: (e) => toast.error(errorText(e)),
    });
  };
  const final = idea.status === 'planned' || idea.status === 'used' || idea.status === 'expired';
  const expired = new Date(idea.expiresAt).getTime() < Date.now();

  return (
    <div ref={ref} id={`idea-${idea.id}`} className="card row-lift compose-rise"
      style={{ padding: '12px 16px', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start', animationDelay: `${delay}ms`,
        boxShadow: focused ? 'inset 0 0 0 1px var(--color-accent)' : undefined }}>
      <div style={{ flex: '1 1 320px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <Badge tone={IDEA_TONE[idea.status]}>{IDEA_STATUS_LABEL[idea.status]}</Badge>
          <span className="chip" style={{ fontSize: 11 }} title={idea.originRef ?? undefined}>{ORIGIN_LABEL[idea.origin]}{idea.originRef ? ` · ${idea.originRef}` : ''}</span>
          {idea.revisions > 0 && <span className="chip" style={{ fontSize: 11 }}>rev {idea.revisions}</span>}
          {r?.owner && <Badge tone="accent" title="Owner override of the reviewer">owner {r.owner}</Badge>}
          <span className="text-micro" style={{ color: expired && !final ? 'var(--color-warning)' : 'var(--color-ink-dim)', marginLeft: 'auto' }} title={fmtDate(idea.expiresAt)}>
            {fmtExpires(idea.expiresAt)}
          </span>
        </div>
        <div>
          <div style={{ color: 'var(--color-ink)', fontWeight: 500, overflowWrap: 'anywhere' }}>{idea.title}</div>
          {idea.angle && <div className="text-body-sm" style={{ color: 'var(--color-ink-muted)', marginTop: 2, overflowWrap: 'anywhere' }}>{idea.angle}</div>}
        </div>
        {idea.variants.length > 0 && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {idea.variants.map((v, i) => <ResourceChip key={`${v.resource_ref}-${i}`} refId={v.resource_ref} suffix={v.format} title={v.note ? `${v.resource_ref} — ${v.note}` : undefined} />)}
          </div>
        )}
        {(idea.decisions?.length ?? 0) > 0 && (
          <div>
            <div className="text-eyebrow" style={{ marginBottom: 4 }}>Decisions</div>
            <DecisionRows decisions={idea.decisions!} />
          </div>
        )}
        {idea.why && (
          <div className="text-micro" style={{ color: 'var(--color-ink-muted)', overflowWrap: 'anywhere' }}>
            <span style={{ color: 'var(--color-ink-dim)' }}>why · </span>{idea.why}
          </div>
        )}
        {idea.sources.length > 0 && (
          <div className="text-micro" style={{ display: 'flex', gap: '2px 10px', flexWrap: 'wrap', minWidth: 0 }}>
            {idea.sources.map((s) => (
              /^https?:\/\//.test(s)
                ? <a key={s} href={s} target="_blank" rel="noreferrer noopener" className="link-accent" title={s}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 3, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <Icon name="globe" size={11} />{host(s)}
                  </a>
                : <span key={s} style={{ color: 'var(--color-ink-muted)' }}>{s}</span>
            ))}
          </div>
        )}
      </div>

      <div style={{ flex: '0 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {r ? (
          <>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>reviewer</span>
              {r.verdict && <Badge tone={VERDICT_TONE[r.verdict] ?? 'neutral'} title="Idea reviewer verdict">{r.verdict}</Badge>}
            </div>
            {r.scores && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 6 }}>
                {SCORES.map((s) => <ScoreMeter key={s.key} label={s.label} title={s.title} value={r.scores?.[s.key]} />)}
              </div>
            )}
            {(r.comment || r.reason_code) && (
              <div className="text-micro" style={{ color: 'var(--color-ink-muted)', overflowWrap: 'anywhere' }}>
                {r.reason_code && <span className="chip" style={{ fontSize: 10, marginRight: 6 }}>{r.reason_code}</span>}
                {r.comment}
              </div>
            )}
          </>
        ) : <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>not reviewed yet</span>}
        {canDecide && (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <RowActions danger={idea.status !== 'rejected'
              ? <TableAction icon="x" danger title="Reject" disabled={decide.isPending} onClick={() => act('reject')} />
              : undefined}>
              {idea.status !== 'accepted' && <TableAction icon="check" title="Accept" disabled={decide.isPending} onClick={() => act('accept')} />}
            </RowActions>
          </div>
        )}
      </div>
    </div>
  );
}
