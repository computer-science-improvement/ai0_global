import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Modal } from '../Modal';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { useConfirm } from '../ui/ConfirmDialog';
import { describeError, toast } from '../ui/Toast';
import {
  SETUP_SECTIONS, useApplySetup, useDiscardSetup, useSetupProposal,
  type ChannelMetrics, type SetupPostRef, type SetupProposalView, type SetupSection,
} from '../../api/channel-setup';
import {
  currentRows, evidencePosts, fmtUsd, isReviewable, isRunning, proposedRows, SECTION_HINT, SECTION_LABEL, SETUP_STATUS, sectionPostKeys, type Row,
} from '../../lib/channel-setup';

// Spec 042 FR-008: one proposal per channel. Six sections, each "now → proposed" with the posts it rests on;
// the owner ticks the sections to apply. Sections changed since the analysis are refused by the server and
// shown inline; locked formatting fields and series are kept.

export function SetupProposalDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useSetupProposal(id);
  const v = q.data;
  const title = v ? `Setup from history · ${v.proposal.channelKey}` : 'Setup from history';
  return (
    <Modal open={!!id} onClose={onClose} size="lg" icon="sparkles" title={title}
      subtitle={v ? `${v.posts.length} posts read · ${new Date(v.proposal.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}` : undefined}>
      {q.error && <div className="callout-danger">{describeError(q.error)}</div>}
      {!v && !q.error && <div className="panel" style={{ height: 160, opacity: 0.55 }} />}
      {v && <ProposalBody v={v} onClose={onClose} />}
    </Modal>
  );
}

function ProposalBody({ v, onClose }: { v: SetupProposalView; onClose: () => void }) {
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
  const confirm = useConfirm();
  const changed = new Set<SetupSection>([...v.drift, ...refused]);

  const toggle = (s: SetupSection) => setPicked((cur) => {
    const n = new Set(cur);
    if (n.has(s)) n.delete(s); else n.add(s);
    return n;
  });

  const doApply = () => {
    const sections = SETUP_SECTIONS.filter((s) => picked.has(s));
    apply.mutate({ id: p.id, sections }, {
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
    if (!(await confirm(`discard this proposal for ${p.channelKey}`, { confirmLabel: 'Discard' }))) return;
    discard.mutate(p.id, { onSuccess: onClose, onError: (e) => toast.error(describeError(e)) });
  };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Badge tone={st.tone} title={st.hint}>{st.label}</Badge>
        {p.costUsd > 0 && <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>analysis cost {fmtUsd(p.costUsd)}</span>}
        {p.runId && <Link to="/app/editor/run/$id" params={{ id: p.runId }} className="link-accent text-micro">Open the run</Link>}
      </div>

      {isRunning(p.status) && (
        <div className="callout-warning"><Icon name="clock" size={16} /><div>The agent is reading the posts. This takes a minute; the dialog updates by itself.</div></div>
      )}
      {(p.status === 'failed' || p.status === 'no_access' || p.status === 'too_few_posts') && (
        <div className="callout-danger"><Icon name="warning" size={16} /><div>{p.reason ?? st.hint ?? 'The analysis did not finish.'}</div></div>
      )}

      {p.metrics && <MetricsStrip m={p.metrics} />}
      {p.sections?.summary && <p className="text-body-sm" style={{ margin: 0, color: 'var(--color-ink)', whiteSpace: 'pre-wrap' }}>{p.sections.summary}</p>}
      {v.kept.length > 0 && reviewable && (
        <div className="text-micro" style={{ color: 'var(--color-ink-muted)', display: 'flex', gap: 6, alignItems: 'center' }}>
          <Icon name="lock" size={12} /> <span>Locked by you and kept as is: {v.kept.join(', ')}.</span>
        </div>
      )}

      {p.sections && SETUP_SECTIONS.map((s) => (
        <SectionBlock key={s} section={s} v={v} reviewable={reviewable}
          state={p.sectionStatus[s] ?? 'pending'} checked={picked.has(s)} onToggle={() => toggle(s)}
          changed={changed.has(s)} failed={failed?.section === s ? failed.error : null} />
      ))}

      <div className="modal-foot" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div>
          {['ready', 'partially_applied', 'queued', 'failed', 'no_access', 'too_few_posts'].includes(p.status) && (
            <button type="button" className="btn-secondary" disabled={discard.isPending} onClick={doDiscard}>Discard</button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          {reviewable && (
            <button type="button" className="btn-primary" disabled={!picked.size || apply.isPending} onClick={doApply}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
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
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
      {items.map(([k, val]) => (
        <div key={k} style={{ background: 'var(--color-surface-1)', borderRadius: 'var(--radius-md, 8px)', padding: '8px 10px', minWidth: 0 }}>
          <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{k}</div>
          <div className="text-body-sm" style={{ color: 'var(--color-ink)', overflowWrap: 'anywhere' }}>{val}</div>
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
    <section style={{ border: '1px solid var(--color-hairline-soft)', borderRadius: 'var(--radius-md, 8px)', padding: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        {canPick && (
          <input id={boxId} type="checkbox" checked={checked} onChange={onToggle} disabled={changed}
            style={{ marginTop: 3, width: 16, height: 16, accentColor: 'var(--color-accent)' }} />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label htmlFor={canPick ? boxId : undefined} style={{ fontWeight: 600, fontSize: 14, color: 'var(--color-ink)', cursor: canPick ? 'pointer' : 'default' }}>
              {SECTION_LABEL[section]}
            </label>
            {state === 'applied' && <Badge tone="success">applied</Badge>}
            {state === 'skipped' && <Badge>skipped</Badge>}
            {changed && <Badge tone="danger" title="This section was edited after the analysis; run the analysis again to review it">changed since analysis</Badge>}
          </div>
          <div className="text-micro" style={{ color: 'var(--color-ink-muted)', marginTop: 2 }}>{SECTION_HINT[section]}</div>
          {failed && <div className="callout-danger" style={{ marginTop: 8 }}><Icon name="warning" size={14} /><div>{failed}</div></div>}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10, marginTop: 10 }}>
            <Rows title="Now" rows={now} empty="Not set" muted />
            <Rows title="Proposed" rows={proposed} empty="—" />
          </div>

          {s[section].evidence?.note && (
            <div className="text-micro" style={{ marginTop: 8, color: 'var(--color-ink-muted)', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
              <span style={{ flex: '0 0 auto', marginTop: 1 }}><Icon name="hint" size={12} /></span><span>{s[section].evidence.note}</span>
            </div>
          )}
          {posts.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <button type="button" className="btn-tiny" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
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
    <div style={{ minWidth: 0 }}>
      <div className="text-micro" style={{ color: 'var(--color-ink-dim)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>{title}</div>
      {rows.length === 0
        ? <div className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>{empty}</div>
        : (
          <dl style={{ margin: 0, display: 'grid', gap: 4 }}>
            {rows.map((r, i) => (
              <div key={`${r.label}-${i}`} className="text-body-sm" style={{ color: muted ? 'var(--color-ink-muted)' : 'var(--color-ink)', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
                <dt style={{ display: 'inline', color: 'var(--color-ink-dim)' }}>{r.label}: </dt>
                <dd style={{ display: 'inline', margin: 0 }}>{r.value}</dd>
              </div>
            ))}
          </dl>
        )}
    </div>
  );
}

function PostList({ posts }: { posts: SetupPostRef[] }) {
  return (
    <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'grid', gap: 4 }}>
      {posts.map((x) => (
        <li key={x.key} className="text-micro" style={{ display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 }}>
          <span style={{ color: 'var(--color-ink-dim)', fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }}>{x.key}</span>
          <a href={x.link} target="_blank" rel="noreferrer" className="link-accent" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
            {x.firstLine || (x.mediaType ? `[${x.mediaType}]` : 'Open post')}
          </a>
          {x.views != null && <span style={{ color: 'var(--color-ink-dim)', flex: '0 0 auto' }}>{x.views.toLocaleString('en-GB')} views</span>}
        </li>
      ))}
    </ul>
  );
}
