// Ideas tab of /app/agents/$handle (spec 020 FR-011): the network's idea pool
// with status filters (counts from one fetch), per idea the angle, variants per
// platform, sources, why, the reviewer's five scores and comment, expiry, and
// the owner override (accept / reject) while the idea is not final, and — once
// planned — the per-resource decision matrix (spec 024 FR-011). Each idea is a
// compact card (status, origin, title, angle, reviewer verdict + average score,
// expiry); a click opens a dialog with everything else and Accept / Reject.
// Spec 078 D2: classes of agent-playbook.css (prefix apb-).

import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { RowActions, TableAction } from '../ui/table';
import { CompactCard } from '../ui/CompactCard';
import { useConfirm } from '../ui/ConfirmDialog';
import { toast } from '../ui/Toast';
import { SegmentedTabs } from '../SegmentedTabs';
import { fmtDate } from '../../lib/format';
import { useDecideIdea, useIdeas, type IdeaRow, type IdeaScores, type IdeaStatus } from '../../api/network';
import { DecisionRows } from './AgentPlan';
import { Block, Fact } from './AgentPlaybook';
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

  const options = FILTERS.map((f) => ({
    key: f.key, label: f.label,
    count: q.data ? (f.key === 'all' ? ideas.length : counts[f.key] ?? 0) : undefined,
  }));

  return (
    <div className="apb-stack">
      <div>
        <SegmentedTabs value={filter} onChange={setFilter} options={options} ariaLabel="Idea status" />
      </div>
      {!q.data && <div className="apb-skeleton" style={{ height: 140 }} aria-hidden />}
      {q.data && shown.length === 0 && (
        <EmptyState icon="sparkles" title={filter === 'all' ? 'The idea pool is empty' : `No ${IDEA_STATUS_LABEL[filter as IdeaStatus]} ideas`}
          note="The orchestrator adds ideas from sources, series and directives; the idea reviewer scores them before the planner may use them." />
      )}
      <div className="compact-grid">
        {shown.map((idea, i) => <IdeaCard key={idea.id} idea={idea} delay={Math.min(i, 12) * 25} focused={idea.id === focus} />)}
      </div>
    </div>
  );
}

function host(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; }
}

/** Average of the reviewer's five scores (one decimal), or null when not scored. */
function avgScore(scores: Partial<IdeaScores> | undefined): number | null {
  if (!scores) return null;
  const v = SCORES.map((x) => scores[x.key]).filter((n): n is number => typeof n === 'number');
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
}

/**
 * One idea as a compact card: status, origin, title, the angle, the reviewer's verdict and average score, expiry.
 * A click opens the dialog with variants, decisions, why, sources, the five scores and the owner's Accept / Reject.
 */
function IdeaCard({ idea, delay, focused }: { idea: IdeaRow; delay: number; focused: boolean }) {
  const canDecide = DECIDABLE.includes(idea.status);
  const r = idea.review;
  const final = idea.status === 'planned' || idea.status === 'used' || idea.status === 'expired';
  const expired = new Date(idea.expiresAt).getTime() < Date.now();
  const avg = avgScore(r?.scores);

  return (
    <CompactCard id={`idea-${idea.id}`} delay={delay} focused={focused} hint="Open the idea"
      top={<>
        <Badge tone={IDEA_TONE[idea.status]}>{IDEA_STATUS_LABEL[idea.status]}</Badge>
        <span className="chip apb-nowrap">{ORIGIN_LABEL[idea.origin]}</span>
      </>}
      meta={<span className={`mono${expired && !final ? ' apb-warn' : ''}`} title={fmtDate(idea.expiresAt)}>{fmtExpires(idea.expiresAt)}</span>}
      title={idea.title}
      body={idea.angle || undefined}
      extra={(
        <span className="text-micro apb-idea-foot">
          {r ? <>
            <span>reviewer</span>
            {r.verdict && <Badge tone={VERDICT_TONE[r.verdict] ?? 'neutral'} title="Idea reviewer verdict">{r.verdict}</Badge>}
            {avg != null && <span className="mono tabular-nums apb-muted" title="Average of the five reviewer scores">avg {avg}/5</span>}
            {r.owner && <Badge tone="accent" title="Owner override of the reviewer">owner {r.owner}</Badge>}
          </> : <span>not reviewed yet</span>}
          {idea.variants.length > 0 && <span className="apb-idea-variants">{idea.variants.length} variant{idea.variants.length === 1 ? '' : 's'}</span>}
        </span>
      )}
      dialog={{
        size: 'lg', icon: 'sparkles', title: idea.title,
        subtitle: `${IDEA_STATUS_LABEL[idea.status]} · ${ORIGIN_LABEL[idea.origin]} · ${fmtExpires(idea.expiresAt)}`,
        body: () => <IdeaDetails idea={idea} />,
        actions: canDecide ? (close) => <IdeaActions idea={idea} onDone={close} /> : undefined,
      }} />
  );
}

function IdeaActions({ idea, onDone }: { idea: IdeaRow; onDone?: () => void }) {
  const confirm = useConfirm();
  const decide = useDecideIdea();
  const act = async (decision: 'accept' | 'reject') => {
    if (decision === 'reject' && !(await confirm(`reject the idea «${idea.title}»`, { confirmLabel: 'Reject' }))) return;
    decide.mutate({ id: idea.id, decision }, {
      onSuccess: () => { toast.success(decision === 'accept' ? 'Idea accepted' : 'Idea rejected'); onDone?.(); },
      onError: (e) => toast.error(errorText(e)),
    });
  };
  return (
    <RowActions danger={idea.status !== 'rejected'
      ? <TableAction icon="x" danger label="Reject" title="Reject" disabled={decide.isPending} onClick={() => act('reject')} />
      : undefined}>
      {idea.status !== 'accepted' && <TableAction icon="check" label="Accept" title="Accept" disabled={decide.isPending} onClick={() => act('accept')} />}
    </RowActions>
  );
}

/** Everything about one idea: the dialog body. */
function IdeaDetails({ idea }: { idea: IdeaRow }) {
  const r = idea.review;
  const final = idea.status === 'planned' || idea.status === 'used' || idea.status === 'expired';
  const expired = new Date(idea.expiresAt).getTime() < Date.now();
  return (
    <div className="apb-col">
      <div className="apb-chips">
        <Badge tone={IDEA_TONE[idea.status]}>{IDEA_STATUS_LABEL[idea.status]}</Badge>
        <span className="chip" title={idea.originRef ?? undefined}>{ORIGIN_LABEL[idea.origin]}{idea.originRef ? ` · ${idea.originRef}` : ''}</span>
        {idea.revisions > 0 && <span className="chip mono">rev {idea.revisions}</span>}
        {r?.owner && <Badge tone="accent" title="Owner override of the reviewer">owner {r.owner}</Badge>}
        <span className={`text-micro mono apb-idea-expiry${expired && !final ? ' apb-warn' : ' apb-dim'}`} title={fmtDate(idea.expiresAt)}>
          {fmtExpires(idea.expiresAt)}
        </span>
      </div>
      {idea.angle && <p className="apb-prose">{idea.angle}</p>}
      {idea.variants.length > 0 && (
        <Block title="Variants">
          <div className="apb-chips">
            {idea.variants.map((v, i) => <ResourceChip key={`${v.resource_ref}-${i}`} refId={v.resource_ref} suffix={v.format} title={v.note ? `${v.resource_ref} — ${v.note}` : undefined} />)}
          </div>
        </Block>
      )}
      {(idea.decisions?.length ?? 0) > 0 && (
        <Block title="Decisions">
          <DecisionRows decisions={idea.decisions!} />
        </Block>
      )}
      {idea.why && (
        <Block title="Why">
          <p className="apb-prose apb-muted">{idea.why}</p>
        </Block>
      )}
      {idea.sources.length > 0 && (
        <Block title="Sources">
          <div className="apb-sources">
            {idea.sources.map((s) => (
              /^https?:\/\//.test(s)
                ? <a key={s} href={s} target="_blank" rel="noreferrer noopener" className="link-accent apb-source" title={s}>
                    <Icon name="globe" size={11} />{host(s)}
                  </a>
                : <span key={s} className="apb-muted">{s}</span>
            ))}
          </div>
        </Block>
      )}
      <Fact title="Reviewer">
        {r ? (
          <>
            {r.verdict && <div><Badge tone={VERDICT_TONE[r.verdict] ?? 'neutral'} title="Idea reviewer verdict">{r.verdict}</Badge></div>}
            {r.scores && (
              <div className="apb-scores">
                {SCORES.map((s) => <ScoreMeter key={s.key} label={s.label} title={s.title} value={r.scores?.[s.key]} />)}
              </div>
            )}
            {(r.comment || r.reason_code) && (
              <p className="apb-prose apb-muted">
                {r.reason_code && <span className="chip mono apb-code">{r.reason_code}</span>}
                {r.comment}
              </p>
            )}
          </>
        ) : <span className="text-micro apb-dim">Not reviewed yet.</span>}
      </Fact>
      <div className="text-micro mono tabular-nums apb-dim apb-ids">
        <span>expires {fmtDate(idea.expiresAt)}</span>
        <span title={idea.id}>id {idea.id.slice(0, 8)}</span>
      </div>
    </div>
  );
}
