// Spec 072 FR-008: the channel doctor's result as one compact card (the count, the first blocker, the last 24 hours) and a
// details dialog (Blockers, Warnings, Info, "Fixed by code" as rows in flush panels; Recheck and Fix all). The words are the
// server's (title, detail, fix label); the card is placed on the agent Overview, the editor page and the launch panel.

import { Link } from '@tanstack/react-router';
import { Badge } from '../ui/Badge';
import { CompactCard } from '../ui/CompactCard';
import { useConfirm } from '../ui/ConfirmDialog';
import { Icon } from '../ui/Icon';
import { EmptyState } from '../ui/primitives';
import { toast } from '../ui/Toast';
import { useFixReadiness, useReadiness, useRecheckReadiness, type ReadinessFinding, type ReadinessView } from '../../api/readiness';
import { alignPrompt } from '../../lib/align';
import { fmtDate, fmtRelative } from '../../lib/format';
import {
  AUTO_FIXED_CODE, badgesOf, bodyLine, fixAllNote, fixAllPhrase, fixLabels, fixToasts, hasFix, last24hLine, sectionsOf, splitLink,
} from '../../lib/readiness';
// The stylesheet (readiness.css) is imported by routes/app.tsx: node tests load this module through the launch panel.

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

interface Props {
  channelKey: string;
  /** The orchestrator's handle, for "Resolve in one card"; falls back to the one the view names. */
  handle?: string | null;
  /** Deep link (`?readiness=1`): scroll to the card and open the dialog. */
  focused?: boolean;
  /** What to show when there is no result (a 404 or an error): nothing (the Overview) or an empty state (the launch panel). */
  whenMissing?: 'hide' | 'empty';
  delay?: number;
}

export function ReadinessPanel({ channelKey, handle, focused = false, whenMissing = 'hide', delay = 0 }: Props) {
  const q = useReadiness(channelKey);
  const v = q.data;
  if (!v) {
    if (q.isLoading) return whenMissing === 'empty' ? <div className="panel compose-rise rdy-skeleton" aria-busy="true" /> : null;
    return whenMissing === 'empty'
      ? <EmptyState icon="info" title="Readiness is not available" note="The check could not be read for this channel. Try again in a minute." />
      : null;
  }
  const agent = handle ?? v.agent;
  return (
    <CompactCard
      delay={delay} focused={focused} attention={v.blockers > 0} hint="Open the readiness details"
      top={<>{badgesOf(v).map((b) => <Badge key={b.label} tone={b.tone}>{b.label}</Badge>)}</>}
      meta={`checked ${fmtRelative(v.checkedAt)}`}
      title="Readiness"
      body={bodyLine(v)} lines={1}
      extra={<span className="text-micro ink-dim rdy-24h">{last24hLine(v.last24h)}</span>}
      note={fixAllNote(v) ?? undefined} noteTone="warning"
      dialog={{
        title: 'Readiness', subtitle: `${v.channelKey} · checked ${fmtDate(v.checkedAt)}`, icon: 'health', size: 'lg',
        body: () => <ReadinessDetails view={v} handle={agent} />,
        actions: () => <ReadinessActions view={v} />,
      }}
    />
  );
}

const ROW_TONE = { error: 'danger', warn: 'warning', info: 'neutral' } as const;
const ROW_LABEL = { error: 'blocker', warn: 'warning', info: 'info' } as const;

function ReadinessDetails({ view, handle }: { view: ReadinessView; handle: string | null }) {
  const s = sectionsOf(view.findings);
  const none = !s.blockers.length && !s.warnings.length && !s.info.length;
  return (
    <div className="rdy-stack">
      <div className="rdy-lead">
        <div className="text-body-sm ink-muted rdy-wrap">{last24hLine(view.last24h)}</div>
        <div className="text-micro ink-dim">Looked at {fmtDate(view.checkedAt)} · the check runs every 10 minutes and after your changes.</div>
      </div>
      {none && <div className="text-body-sm ink-muted rdy-none">Nothing is open for this channel.</div>}
      <Section title="Blockers" rows={s.blockers} view={view} handle={handle} />
      <Section title="Warnings" rows={s.warnings} view={view} handle={handle} />
      <Section title="Info" rows={s.info} view={view} handle={handle} />
      <Section title="Fixed by code" rows={s.fixed} view={view} handle={handle} />
    </div>
  );
}

function Section({ title, rows, view, handle }: { title: string; rows: ReadinessFinding[]; view: ReadinessView; handle: string | null }) {
  if (!rows.length) return null;
  return (
    <section className="rdy-section" aria-label={title}>
      <div className="rdy-sechead">
        <h3 className="text-overline rdy-h">{title}</h3>
        <span className="rdy-count">{rows.length}</span>
      </div>
      <div className="panel is-flush">
        {rows.map((f) => <FindingRow key={f.key} f={f} channelKey={view.channelKey} handle={handle} />)}
      </div>
    </section>
  );
}

function FindingRow({ f, channelKey, handle }: { f: ReadinessFinding; channelKey: string; handle: string | null }) {
  const fix = useFixReadiness(channelKey);
  const confirm = useConfirm();
  const fixed = f.code === AUTO_FIXED_CODE;
  const link = f.link ? splitLink(f.link) : null;
  const fixOne = async () => {
    if (!f.fix || !(await confirm(lowerFirst(f.fix.label), { confirmLabel: 'Apply fix', danger: false }))) return;
    fix.mutate({ keys: [f.key] }, { onSuccess: (r) => fixToasts(r).forEach((t) => (t.kind === 'error' ? toast.error(t.text) : toast.success(t.text))) });
  };
  return (
    <div className="panel-row rdy-row">
      <span className="rdy-badge"><Badge tone={fixed ? 'success' : ROW_TONE[f.severity]}>{fixed ? 'fixed' : ROW_LABEL[f.severity]}</Badge></span>
      <div className="rdy-main">
        <div className="text-body-sm rdy-title">{f.title}</div>
        {f.detail && <div className="text-micro ink-muted rdy-wrap">{f.detail}</div>}
        <div className="text-micro ink-dim rdy-meta">
          {f.subject?.label && <span className="rdy-wrap">{f.subject.label}</span>}
          {f.firstSeenAt && <span>{fixed ? 'Fixed' : 'Since'} {fmtDate(f.firstSeenAt)}</span>}
        </div>
        {hasFix(f) && (
          <div className="text-micro ink-dim rdy-fixline">
            <Icon name="wrench" size={12} /> <span className="rdy-wrap">{f.fix!.label}</span>
            {f.fix!.auto && <span className="chip">also applied by itself</span>}
          </div>
        )}
      </div>
      {!fixed && (
        <div className="rdy-side">
          {f.code === 'config_conflict' && handle && (
            <Link to="/app/chat" search={{ q: alignPrompt(handle) } as any} className="btn-tiny">Resolve in one card</Link>
          )}
          {link && <Link to={link.to as any} search={link.search as any} className="btn-tiny">Open <Icon name="external" size={12} /></Link>}
          {hasFix(f) && <button type="button" className="btn-tiny" disabled={fix.isPending} onClick={fixOne}>{fix.isPending ? 'Fixing…' : 'Fix'}</button>}
        </div>
      )}
    </div>
  );
}

function ReadinessActions({ view }: { view: ReadinessView }) {
  const recheck = useRecheckReadiness(view.channelKey);
  const fix = useFixReadiness(view.channelKey);
  const confirm = useConfirm();
  const busy = recheck.isPending || fix.isPending;
  const fixAll = async () => {
    const labels = fixLabels(view.findings);
    const ok = await confirm(fixAllPhrase(view.fixable), {
      confirmLabel: 'Fix all', danger: false,
      details: <ul className="text-body-sm">{labels.map((l) => <li key={l}>{l}</li>)}</ul>,
    });
    if (!ok) return;
    fix.mutate({}, { onSuccess: (r) => fixToasts(r).forEach((t) => (t.kind === 'error' ? toast.error(t.text) : toast.success(t.text))) });
  };
  return (
    <>
      <button type="button" className="btn-secondary" disabled={busy} onClick={() => recheck.mutate(undefined, { onSuccess: () => toast.success('Checked again') })}>
        <Icon name="refresh" size={14} /> {recheck.isPending ? 'Checking…' : 'Recheck'}
      </button>
      {view.fixable > 0 && (
        <button type="button" className="btn-primary" disabled={busy} onClick={fixAll}>{fix.isPending ? 'Fixing…' : 'Fix all'}</button>
      )}
    </>
  );
}
