import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Modal } from '../Modal';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { useConfirm } from '../ui/ConfirmDialog';
import { describeError, toast } from '../ui/Toast';
import {
  SETUP_SECTIONS, useAnalyzeChannels, useApplySetup, useDiscardSetup, useSetupOverview, useSetupProposal,
  type ChannelMetrics, type SetupPostRef, type SetupProposalView, type SetupSection,
} from '../../api/channel-setup';
import {
  currentRows, estimateText, evidencePosts, expiredText, fmtUsd, isReviewable, isRunning, proposedRows, SECTION_HINT, SECTION_LABEL, SETUP_STATUS, sectionPostKeys, type Row,
} from '../../lib/channel-setup';

// Spec 042 FR-008: one proposal per channel. Six sections, each "now → proposed" with the posts it rests on;
// the owner ticks the sections to apply. Sections changed since the analysis are refused by the server and
// shown inline; locked formatting fields and series are kept.
// Spec 078 D3: classes (amg-* in agent-manager.css) — an inset of facts, sections as bordered blocks with a picked
// state, overline keys for Now / Proposed, real buttons in the footer. Same mutations, checks and confirm dialogs.

export function SetupProposalDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useSetupProposal(id);
  const v = q.data;
  const title = v ? `Setup from history · ${v.proposal.channelKey}` : 'Setup from history';
  return (
    <Modal open={!!id} onClose={onClose} size="lg" icon="sparkles" title={title}
      subtitle={v ? `${v.posts.length} posts read · ${new Date(v.proposal.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}` : undefined}>
      {q.error && <div className="callout-danger">{describeError(q.error)}</div>}
      {!v && !q.error && <div className="amg-skeleton" aria-hidden />}
      {v && <ProposalBody v={v} onClose={onClose} />}
    </Modal>
  );
}

export function ProposalBody({ v, onClose }: { v: SetupProposalView; onClose: () => void }) {
  const p = v.proposal;
  const st = SETUP_STATUS[p.status];
  const pending = useMemo(() => SETUP_SECTIONS.filter((s) => (p.sectionStatus[s] ?? 'pending') === 'pending'), [p.sectionStatus]);
  const reviewable = isReviewable(p.status) && !!p.sections;
  const [picked, setPicked] = useState<Set<SetupSection>>(() => new Set(pending.filter((s) => !v.drift.includes(s))));
  const [refused, setRefused] = useState<SetupSection[]>([]);
  const [failed, setFailed] = useState<{ section: SetupSection; error: string } | null>(null);
  useEffect(() => { setPicked(new Set(pending.filter((s) => !v.drift.includes(s)))); }, [p.id, pending, v.drift]);
  const apply = useApplySetup();
  const discard = useDiscardSetup();
  const analyze = useAnalyzeChannels();
  const overview = useSetupOverview();
  const confirm = useConfirm();
  const changed = new Set<SetupSection>([...v.drift, ...refused]);

  const toggle = (s: SetupSection) => setPicked((cur) => {
    const n = new Set(cur);
    if (n.has(s)) n.delete(s); else n.add(s);
    return n;
  });

  const doApply = async () => {
    const sections = SETUP_SECTIONS.filter((s) => picked.has(s));
    // A section changed after the analysis is applied only when the owner says so: it replaces that newer change.
    const override = sections.filter((s) => changed.has(s));
    if (override.length && !(await confirm(
      `replace what changed since the analysis in ${override.map((s) => SECTION_LABEL[s].toLowerCase()).join(', ')} with the proposal`,
      { confirmLabel: 'Replace' },
    ))) return;
    apply.mutate({ id: p.id, sections, override }, {
      onSuccess: (r) => {
        setRefused(r.changedSinceAnalysis);
        setFailed(r.failed);
        if (r.applied.length) {
          const kept = r.kept.length ? ` Kept your locked ${r.kept.join(', ')}.` : '';
          toast.success(`Applied ${r.applied.map((s) => SECTION_LABEL[s].toLowerCase()).join(', ')} to ${p.channelKey}.${kept}`);
        }
        if (r.failed) toast.error(`${SECTION_LABEL[r.failed.section]} was not applied: ${r.failed.error}`);
        else if (r.changedSinceAnalysis.length && !r.applied.length) toast.error('Nothing applied: these sections changed since the analysis. Run it again.');
        if (r.proposal?.status === 'applied') onClose();
      },
      onError: (e) => toast.error(describeError(e)),
    });
  };
  const doDiscard = async () => {
    const rest = p.status === 'partially_applied';
    if (!(await confirm(rest ? `skip the sections not applied yet and close this proposal for ${p.channelKey}` : `discard this proposal for ${p.channelKey}`,
      { confirmLabel: rest ? 'Skip the rest' : 'Discard' }))) return;
    discard.mutate(p.id, { onSuccess: onClose, onError: (e) => toast.error(describeError(e)) });
  };

  // Spec 057: an expired proposal is analysed again (a fresh one replaces it) instead of being applied or discarded.
  const doAnalyzeAgain = async () => {
    if (!(await confirm(`analyze the last 20 posts of ${p.channelKey} again: ${estimateText(overview.data?.estimateUsd ?? null, 1)}`,
      { danger: false, confirmLabel: 'Analyze again' }))) return;
    analyze.mutate([p.channelKey], {
      onSuccess: (r) => {
        if (!r.queued[0]) { toast.error(r.refused[0]?.error === 'not_own_channel' ? `${p.channelKey} is not marked as your channel on Tracked` : 'Not queued'); return; }
        toast.success(`Analysis of ${p.channelKey} queued. The new proposal appears in a minute.`);
        onClose();
      },
      onError: (e) => toast.error(describeError(e)),
    });
  };

  return (
    <div className="amg-stack">
      <div className="amg-badges">
        <Badge tone={st.tone} title={st.hint}>{st.label}</Badge>
        {p.costUsd > 0 && <span className="text-micro mono amg-muted">analysis cost {fmtUsd(p.costUsd)}</span>}
        {p.runId && <Link to="/app/editor/run/$id" params={{ id: p.runId }} className="link-accent text-micro">Open the run</Link>}
      </div>

      {isRunning(p.status) && (
        <div className="callout-warning"><Icon name="clock" size={16} /><div>The agent is reading the posts. This takes a minute; the dialog updates by itself.</div></div>
      )}
      {p.status === 'expired' && (
        <div className="text-body-sm amg-muted amg-note is-top">
          <span className="amg-icon"><Icon name="clock" size={14} /></span><span>{expiredText(p.reason)}</span>
        </div>
      )}
      {(p.status === 'failed' || p.status === 'no_access' || p.status === 'too_few_posts') && (
        <div className="callout-danger"><Icon name="warning" size={16} /><div>{p.reason ?? st.hint ?? 'The analysis did not finish.'}</div></div>
      )}

      {p.metrics && <MetricsStrip m={p.metrics} />}
      {p.sections?.summary && <p className="text-body-sm amg-ink amg-pre amg-p">{p.sections.summary}</p>}
      {v.kept.length > 0 && reviewable && (
        <div className="text-micro amg-muted amg-note">
          <Icon name="lock" size={12} /> <span>Locked by you and kept as is: {v.kept.join(', ')}.</span>
        </div>
      )}

      {p.sections && SETUP_SECTIONS.map((s) => (
        <SectionBlock key={s} section={s} v={v} reviewable={reviewable}
          state={p.sectionStatus[s] ?? 'pending'} checked={picked.has(s)} onToggle={() => toggle(s)}
          changed={changed.has(s)} failed={failed?.section === s ? failed.error : null} />
      ))}

      <div className="modal-foot amg-foot-split">
        <div>
          {['ready', 'partially_applied', 'queued', 'failed', 'no_access', 'too_few_posts'].includes(p.status) && (
            <button type="button" className="btn-secondary" disabled={discard.isPending} onClick={doDiscard}
              title={p.status === 'partially_applied' ? 'Close the proposal: the sections not applied are skipped, the applied ones stay' : undefined}>
              {p.status === 'partially_applied' ? 'Skip the rest' : 'Discard'}
            </button>
          )}
        </div>
        <div className="amg-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>Close</button>
          {p.status === 'expired' && (
            <button type="button" className="btn-primary" disabled={analyze.isPending} onClick={() => void doAnalyzeAgain()}>
              <Icon name="refresh" size={14} /> {analyze.isPending ? 'Queuing…' : 'Analyze again'}
            </button>
          )}
          {reviewable && (
            <button type="button" className="btn-primary" disabled={!picked.size || apply.isPending} onClick={doApply}>
              <Icon name="check" size={14} /> {apply.isPending ? 'Applying…' : `Apply selected (${picked.size})`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricsStrip({ m }: { m: ChannelMetrics }) {
  const mix = Object.entries(m.formatMix).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(' · ');
  const items: Array<[string, string]> = [
    ['Posts', `${m.posts} over ${m.spanDays} d`],
    ['Per day', String(m.perDay)],
    ['Peak hours', m.peakHours.length ? m.peakHours.map((h) => `${String(h).padStart(2, '0')}:00`).join(', ') : '—'],
    ['Median views', m.medianViews == null ? '—' : m.medianViews.toLocaleString('en-GB')],
    ['Median length', `${m.length.median} chars`],
    ['Formats', mix || '—'],
  ];
  return (
    <div className="inset amg-metrics">
      {items.map(([k, val]) => (
        <div key={k} className="amg-mcell">
          <span className="text-overline">{k}</span>
          <span className="text-body-sm amg-ink amg-wrap">{val}</span>
        </div>
      ))}
    </div>
  );
}

function SectionBlock({ section, v, reviewable, state, checked, onToggle, changed, failed }: {
  section: SetupSection; v: SetupProposalView; reviewable: boolean; state: 'pending' | 'applied' | 'skipped';
  checked: boolean; onToggle: () => void; changed: boolean; failed: string | null;
}) {
  const [open, setOpen] = useState(false);
  const s = v.proposal.sections!;
  const now = currentRows(section, v.current);
  const proposed = proposedRows(section, s);
  const posts = evidencePosts(sectionPostKeys(section, s), v.posts);
  const canPick = reviewable && state === 'pending';
  const boxId = `setup-${section}`;
  return (
    <section className={`amg-setup-section${canPick && checked ? ' is-picked' : ''}`}>
      <div className="amg-setup-head">
        {canPick && <input id={boxId} type="checkbox" className="amg-check" checked={checked} onChange={onToggle} />}
        <div className="amg-setup-main">
          <div className="amg-setup-title">
            <label htmlFor={canPick ? boxId : undefined} className={`amg-setup-label${canPick ? ' is-pick' : ''}`}>
              {SECTION_LABEL[section]}
            </label>
            {state === 'applied' && <Badge tone="success">applied</Badge>}
            {state === 'skipped' && <Badge>skipped</Badge>}
            {changed && <Badge tone="danger" title="This section was edited after the analysis">changed since analysis</Badge>}
          </div>
          <div className="text-micro amg-muted">{SECTION_HINT[section]}</div>
          {failed && <div className="callout-danger"><Icon name="warning" size={14} /><div>{failed}</div></div>}
          {changed && canPick && (
            <div className={`text-micro ${checked ? 'amg-warn' : 'amg-muted'}`}>
              {checked
                ? 'Applying replaces what changed after the analysis (Now) with the proposal.'
                : 'Edited after the analysis. Tick it to replace that change with the proposal, skip it, or run the analysis again.'}
            </div>
          )}

          <div className="amg-now-proposed">
            <Rows title="Now" rows={now} empty="Not set" muted />
            <Rows title="Proposed" rows={proposed} empty="—" />
          </div>

          {s[section].evidence?.note && (
            <div className="text-micro amg-muted amg-note is-top">
              <span className="amg-icon"><Icon name="hint" size={12} /></span><span>{s[section].evidence.note}</span>
            </div>
          )}
          {posts.length > 0 && (
            <div className="amg-posts-wrap">
              <button type="button" className="btn-ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
                <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} /> {posts.length} post{posts.length === 1 ? '' : 's'} behind this
              </button>
              {open && <PostList posts={posts} />}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Rows({ title, rows, empty, muted = false }: { title: string; rows: Row[]; empty: string; muted?: boolean }) {
  return (
    <div className="amg-rows-col">
      <div className="text-overline">{title}</div>
      {rows.length === 0
        ? <div className="text-body-sm amg-dim">{empty}</div>
        : (
          <dl className="amg-dl">
            {rows.map((r, i) => (
              <div key={`${r.label}-${i}`} className={`text-body-sm amg-dlrow amg-wrap amg-pre ${muted ? 'amg-muted' : 'amg-ink'}`}>
                <dt>{r.label}: </dt>
                <dd>{r.value}</dd>
              </div>
            ))}
          </dl>
        )}
    </div>
  );
}

function PostList({ posts }: { posts: SetupPostRef[] }) {
  return (
    <ul className="amg-postlist">
      {posts.map((x) => (
        <li key={x.key} className="text-micro amg-postlist-row">
          <span className="mono tabular-nums amg-dim amg-nowrap">{x.key}</span>
          <a href={x.link} target="_blank" rel="noreferrer" className="link-accent amg-trunc">
            {x.firstLine || (x.mediaType ? `[${x.mediaType}]` : 'Open post')}
          </a>
          {x.views != null && <span className="mono amg-dim amg-nowrap">{x.views.toLocaleString('en-GB')} views</span>}
        </li>
      ))}
    </ul>
  );
}
