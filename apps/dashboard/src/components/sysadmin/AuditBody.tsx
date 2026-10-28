// Spec 055 FR-003: the sysadmin's audit report in the artifact panel — the summary, counts by severity, the open findings
// by area as compact rows, and the handled ones (applied, dismissed) collapsed at the bottom. A row opens a dialog with the
// detail, the evidence, the model's comment and Apply fix / Dismiss 30 days. "Run again" is the artifact's own action.

import { useState } from 'react';
import { Badge } from '../ui/Badge';
import { CompactCard } from '../ui/CompactCard';
import { Icon } from '../ui/Icon';
import { Field, StatTile } from '../ui/primitives';
import { useConfirm } from '../ui/ConfirmDialog';
import { describeError, toast } from '../ui/Toast';
import { errorBody } from '../../api/agents';
import { useApplyFinding, useDismissFinding, type AuditFinding, type AuditReport } from '../../api/audits';
import type { ArtifactDetail } from '../../api/artifacts';
import { fmtDate, fmtRelative } from '../../lib/format';
import { countsLine, evidenceLines, fixText, groupOpen, handled, llmNotice, SEVERITY_LABEL, SEVERITY_TONE } from '../../lib/sysadmin-audit';

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The subject of a finding as the dialog's second line: its label, then the agent and channel when the label does not say them. */
function subjectLine(s: AuditFinding['subject']): string {
  const parts = [s.label];
  if (s.agent && !s.label.includes(`@${s.agent}`)) parts.push(`@${s.agent}`);
  if (s.channel && !s.label.includes(s.channel)) parts.push(s.channel);
  return parts.join(' · ');
}

/** A refused fix as one line: the error code and what the server said. */
function reason(e: unknown): string {
  const b = errorBody(e);
  if (b?.error) return `${String(b.error).replace(/_/g, ' ')}${b.details ? `: ${typeof b.details === 'string' ? b.details : JSON.stringify(b.details)}` : ''}`;
  return describeError(e);
}

export function AuditBody({ d }: { d: ArtifactDetail }) {
  const r = d.body as AuditReport | null;
  const [showHandled, setShowHandled] = useState(false);
  if (!r) return null;
  if (r.status === 'running') {
    return (
      <div className="callout" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Icon name="clock" size={16} />
        <div>The audit is running. It checks skills, memory, rules and tools in code, then asks the model for a short judgement; this page refreshes by itself.</div>
      </div>
    );
  }
  if (r.status === 'failed') return <div className="callout-danger"><Icon name="warning" size={16} /><div>The audit failed{r.error ? `: ${r.error}` : ''}. Run it again.</div></div>;

  const groups = groupOpen(r.findings);
  const done = handled(r.findings);
  const notice = llmNotice(r);
  return (
    <>
      {r.summary && <div className="text-body-sm" style={{ whiteSpace: 'pre-wrap' }}>{r.summary}</div>}
      {notice && <div className="callout-warning"><Icon name="warning" size={16} /><div>{notice}</div></div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 8 }}>
        <StatTile label="Errors" value={r.counts.error} icon="warning" />
        <StatTile label="Warnings" value={r.counts.warn} icon="warning" />
        <StatTile label="Info" value={r.counts.info} icon="eye" />
        <StatTile label="With a fix" value={r.counts.fixable} icon="wrench" />
      </div>
      <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>
        {countsLine(r.counts)} · {r.trigger === 'owner' ? 'run on request' : 'weekly run'} {fmtRelative(r.finishedAt ?? r.startedAt)} · ${r.costUsd.toFixed(3)}
      </div>

      {!groups.length && <div className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>{r.counts.total ? 'Every finding is handled.' : 'The checks found nothing to report.'}</div>}
      {groups.map((g) => (
        <Field key={g.area} label={`${g.label} (${g.findings.length})`}>
          <div style={{ display: 'grid', gap: 6 }}>
            {g.findings.map((f, i) => <FindingCard key={f.key} report={r} f={f} delay={i * 30} />)}
          </div>
        </Field>
      ))}

      {done.length > 0 && (
        <div>
          <button type="button" className="btn-ghost" aria-expanded={showHandled} onClick={() => setShowHandled(!showHandled)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name={showHandled ? 'chevron-up' : 'chevron-down'} size={13} /> Handled ({done.length})
          </button>
          {showHandled && (
            <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
              {done.map((f) => (
                <div key={f.key} className="panel" style={{ padding: '8px 10px', display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <Badge tone={f.status === 'applied' ? 'success' : 'neutral'}>{f.status}</Badge>
                  <span className="text-body-sm" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{f.title}</span>
                  <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{f.result ?? f.subject.label}{f.at ? ` · ${fmtDate(f.at)}` : ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function FindingCard({ report, f, delay }: { report: AuditReport; f: AuditFinding; delay: number }) {
  return (
    <CompactCard
      delay={delay} hint="Open the finding"
      top={<><Badge tone={SEVERITY_TONE[f.severity]}>{SEVERITY_LABEL[f.severity]}</Badge>{f.status === 'failed' && <Badge tone="danger">fix failed</Badge>}{f.fix && <span className="chip">fix</span>}</>}
      title={f.title}
      body={f.comment ?? f.subject.label}
      note={f.status === 'failed' ? f.result : undefined} noteTone="danger"
      dialog={{
        title: f.title, subtitle: subjectLine(f.subject), icon: 'eye',
        body: () => <FindingDetails f={f} />,
        actions: (close) => <FindingActions report={report} f={f} onDone={close} />,
      }}
    />
  );
}

function FindingDetails({ f }: { f: AuditFinding }) {
  const lines = evidenceLines(f.evidence);
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="text-body-sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{f.detail}</div>
      {f.comment && (
        <Field label="Sysadmin's comment"><div className="text-body-sm" style={{ whiteSpace: 'pre-wrap' }}>{f.comment}</div></Field>
      )}
      {f.status === 'failed' && f.result && <div className="callout-danger"><Icon name="warning" size={16} /><div>The fix was refused: {f.result}</div></div>}
      {f.fix && <Field label="Fix"><div className="text-body-sm">{fixText(f.fix)}</div></Field>}
      {lines.length > 0 && (
        <Field label="Evidence">
          <div className="text-micro" style={{ display: 'grid', gap: 2, color: 'var(--color-ink-muted)', fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}>
            {lines.map((l) => <div key={l}>{l}</div>)}
          </div>
        </Field>
      )}
      <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{f.check.replace(/_/g, ' ')} · {f.area}</div>
    </div>
  );
}

function FindingActions({ report, f, onDone }: { report: AuditReport; f: AuditFinding; onDone: () => void }) {
  const apply = useApplyFinding();
  const dismiss = useDismissFinding();
  const confirm = useConfirm();
  const busy = apply.isPending || dismiss.isPending;
  const doApply = async () => {
    if (!f.fix || !(await confirm(lowerFirst(fixText(f.fix)), { confirmLabel: 'Apply fix' }))) return;
    apply.mutate({ id: report.id, key: f.key }, {
      onSuccess: (r) => { toast.success(r.result ?? 'Fix applied'); onDone(); },
      onError: (e) => toast.error(`The fix was refused — ${reason(e)}`),
    });
  };
  const doDismiss = () => dismiss.mutate({ id: report.id, key: f.key, days: 30 }, {
    onSuccess: () => { toast.success('Dismissed for 30 days'); onDone(); },
    onError: (e) => toast.error(reason(e)),
  });
  return (
    <>
      <button type="button" className="btn-ghost" disabled={busy} onClick={doDismiss}>Dismiss 30 days</button>
      {f.fix
        ? <button type="button" className="btn-primary" disabled={busy} onClick={doApply}>Apply fix</button>
        : <span className="text-micro" style={{ color: 'var(--color-ink-dim)', alignSelf: 'center' }}>No automatic fix: change it by hand.</span>}
    </>
  );
}
