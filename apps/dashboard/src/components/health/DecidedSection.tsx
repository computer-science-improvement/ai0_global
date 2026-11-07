// Spec 090 FR-010: "Decided without you" on /app/health — what the system decided in the last 14 days because the owner stayed
// silent, as compact cards (date, channel, the summary, a family chip, an "Undone" state). The details dialog has the facts and,
// where the decision can be reversed, an Undo with a confirm step.

import { SectionCard, EmptyState } from '../ui/primitives';
import { CompactCard } from '../ui/CompactCard';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { describeError, toast } from '../ui/Toast';
import { useConfirm } from '../ui/ConfirmDialog';
import { fmtDate } from '../../lib/format';
import { useDecisions, useUndoDecision, type AutonomyDecision } from '../../api/autonomy';
import {
  ACTION_LABEL, DECIDED_DAYS, DECIDED_LIMIT, STATE_LABEL, STATE_TONE, decisionState, familyLabel, sinceIso, undoErrorText, visibleDecisions,
} from '../../lib/autonomy';
import './health.css';

const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="inset" style={{ marginBottom: 8 }}>
      <div className="text-overline">{label}</div>
      <div className="text-body-sm" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{children}</div>
    </div>
  );
}

function DecisionCard({ d, delay }: { d: AutonomyDecision; delay: number }) {
  const undo = useUndoDecision();
  const confirm = useConfirm();
  const state = decisionState(d);
  const run = async (close: () => void) => {
    const ok = await confirm('undo this decision', {
      danger: false, confirmLabel: 'Undo',
      details: <div className="text-body-sm ink-muted">{d.summary}</div>,
    });
    if (!ok) return;
    undo.mutate(d.id, {
      onSuccess: () => { toast.success('Decision undone'); close(); },
      onError: (e) => toast.error(undoErrorText(e) || describeError(e)),
    });
  };
  return (
    <CompactCard
      delay={delay}
      hint="Open the decision"
      top={<>
        <span className="text-micro mono ink-dim">{day(d.decidedAt)}</span>
        {d.channelKey && <span className="text-caption mono">{d.channelKey}</span>}
        <Badge tone="neutral">{familyLabel(d.family)}</Badge>
        <Badge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Badge>
      </>}
      body={d.summary}
      lines={2}
      note={state === 'failed' ? 'The change did not go through' : undefined}
      noteTone="danger"
      dialog={{
        title: familyLabel(d.family),
        subtitle: `${fmtDate(d.decidedAt)}${d.channelKey ? ` · ${d.channelKey}` : ''}`,
        icon: 'history',
        size: 'md',
        body: () => (
          <>
            <p className="text-body" style={{ marginTop: 0 }}>{d.summary}</p>
            <Fact label="What happened">{ACTION_LABEL[d.action]} because you did not answer in time</Fact>
            <Fact label="Rule"><span className="mono">{d.gate}</span></Fact>
            <Fact label="Item"><span className="mono">{d.refType}:{d.refId}</span></Fact>
            {state === 'undone' && <Fact label="Undone">{d.undoneAt ? fmtDate(d.undoneAt) : '—'}{d.undoneBy ? ` by ${d.undoneBy}` : ''}</Fact>}
            {!d.canUndo && state !== 'undone' && <p className="text-caption ink-dim">This kind of decision cannot be undone from here.</p>}
          </>
        ),
        actions: (close) => (
          <>
            <button type="button" className="btn-ghost" onClick={close}>Close</button>
            {d.canUndo && (
              <Button variant="secondary" disabled={undo.isPending} onClick={() => run(close)}>
                {undo.isPending ? 'Undoing…' : 'Undo'}
              </Button>
            )}
          </>
        ),
      }}
    />
  );
}

export function DecidedSection({ delay }: { delay?: number }) {
  // The window is fixed when the page opens; the list refetches every minute.
  const q = useDecisions({ since: sinceIso(DECIDED_DAYS, new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000)), limit: DECIDED_LIMIT });
  const rows = q.data ? visibleDecisions(q.data.decisions) : null;
  return (
    <SectionCard title="Decided without you" icon="history" delay={delay} style={{ marginBottom: 16 }}>
      {q.error ? <div className="callout-danger" role="alert">{describeError(q.error)}</div>
        : !rows ? <div className="hl-skeleton" aria-busy="true" style={{ height: 120 }} />
        : !rows.length ? <EmptyState tone="clear" title="Nothing decided for you" note={`Nothing was decided without you in the last ${DECIDED_DAYS} days.`} />
        : <div className="compact-grid">{rows.map((d, i) => <DecisionCard key={d.id} d={d} delay={Math.min(i, 8) * 30} />)}</div>}
    </SectionCard>
  );
}
