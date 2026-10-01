// Playbook tab of /app/agents/$handle (spec 020 FR-011): the network header
// with the mirror/orchestrated switch, the pending version awaiting approval
// (reviewer verdict + a diff vs the active one), the active playbook rendered
// per resource, "Rebuild from brief", the owner editor and version history.

import { Link } from '@tanstack/react-router';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { EmptyState, SectionCard } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { useConfirm } from '../ui/ConfirmDialog';
import { toast } from '../ui/Toast';
import { Modal } from '../Modal';
import { fmtDate, fmtRelative } from '../../lib/format';
import {
  useAgentNetwork, useDecidePlaybook, usePlaybook, useRebuildPlaybook, useSetNetworkMode,
  type AgentNetwork, type Playbook, type PlaybookPlatform, type PlaybookRow,
} from '../../api/network';
import {
  NETWORK_MODE_TONE, NetworkError, PLAYBOOK_TONE, ResourceChip, ResourceLabel, WeightBar, errorText, fmtCadence, hourLabel,
} from './NetworkUi';
import { diffPlaybooks, type DiffGroup } from './playbookDiff';
import { PlaybookEditor } from './PlaybookEditor';

const eyebrow: CSSProperties = { color: 'var(--color-ink-dim)', textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 10, marginBottom: 6 };
const btn: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6 };

export function AgentPlaybook({ handle, orchestrator }: { handle: string; orchestrator: string }) {
  const net = useAgentNetwork(handle);
  const pb = usePlaybook(handle);
  const [editing, setEditing] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [viewing, setViewing] = useState<PlaybookRow | null>(null);

  if (pb.error) return <NetworkError error={pb.error} />;
  if (!pb.data) return <div className="panel compose-rise" style={{ height: 160, opacity: 0.55 }} />;
  const { active, pending, history } = pb.data;

  const rebuildBtn = (
    <button type="button" className="btn-secondary" style={btn} onClick={() => setRebuilding(true)}>
      <Icon name="sparkles" size={14} /> Rebuild from brief
    </button>
  );

  return (
    <div>
      <NetworkHeader handle={handle} orchestrator={orchestrator} net={net.data ?? null} error={net.error} hasActive={!!active} />

      {pending && <PendingCard row={pending} active={active} />}

      {active ? (
        <SectionCard
          title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>Active playbook <Badge tone="success">v{active.version}</Badge></span>}
          icon="logs" delay={40} style={{ marginBottom: 16 }}
          action={(
            <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <button type="button" className="btn-act" title="Rebuild from brief" aria-label="Rebuild from brief" onClick={() => setRebuilding(true)}>
                <Icon name="sparkles" size={14} />
              </button>
              <button type="button" className="btn-act" title="Edit" aria-label="Edit playbook" onClick={() => setEditing(true)}>
                <Icon name="pencil" size={14} />
              </button>
            </span>
          )}
        >
          <VersionMeta row={active} />
          <PlaybookView body={active.body} />
        </SectionCard>
      ) : (
        <div className="compose-rise" style={{ marginBottom: 16 }}>
          <EmptyState icon="logs" title={pending ? 'No active playbook yet' : 'No playbook yet'}
            note={pending
              ? 'Approve the pending version above to make it active, or rebuild it from a new brief.'
              : 'The orchestrator turns your brief into a structured playbook for every resource of the network: roles, formats, cadence, series and rules.'}
            action={rebuildBtn} />
        </div>
      )}

      {history.length > 0 && <HistoryCard rows={history} onOpen={setViewing} />}

      {rebuilding && <RebuildModal handle={handle} hasActive={!!active} onClose={() => setRebuilding(false)} />}
      {editing && active && (
        <PlaybookEditor handle={handle} row={active} resources={net.data?.resources ?? []} onClose={() => setEditing(false)} />
      )}
      {viewing && <HistoryModal row={viewing} history={history} onClose={() => setViewing(null)} />}
    </div>
  );
}

function VersionMeta({ row }: { row: PlaybookRow }) {
  return (
    <div className="text-micro" style={{ color: 'var(--color-ink-muted)', margin: '-4px 0 14px', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <span>by {row.createdBy}</span>
      <span>·</span>
      <span title={fmtDate(row.createdAt)}>{fmtRelative(row.createdAt)}</span>
      {row.rationale && <><span>·</span><span style={{ color: 'var(--color-ink)', overflowWrap: 'anywhere' }}>{row.rationale}</span></>}
    </div>
  );
}

// ── network header + mode switch ──

function NetworkHeader({ handle, orchestrator, net, error, hasActive }: { handle: string; orchestrator: string; net: AgentNetwork | null; error: unknown; hasActive: boolean }) {
  if (error) return <div style={{ marginBottom: 16 }}><NetworkError error={error} /></div>;
  if (!net) return <div className="panel compose-rise" style={{ height: 88, opacity: 0.55, marginBottom: 16 }} />;
  const grouped = !!net.groupId && net.mode !== 'single';
  return (
    <section className="panel compose-rise" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <span className="section-glyph"><Icon name="agents" size={15} /></span>
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--color-ink)', letterSpacing: '-0.01em' }}>
              {grouped ? net.groupName ?? 'Network' : 'No network'}
            </h2>
            <Badge tone={NETWORK_MODE_TONE[net.mode]}>{net.mode}</Badge>
          </div>
          <div className="text-micro" style={{ color: 'var(--color-ink-muted)', marginTop: 4 }}>
            {grouped
              ? net.mode === 'orchestrated'
                ? <>Native posts for every resource are planned by this orchestrator from <strong style={{ color: 'var(--color-ink)' }}>{net.anchor}</strong>.</>
                : <>Telegram posts of <strong style={{ color: 'var(--color-ink)' }}>{net.anchor}</strong> are mirrored to the group.</>
              : <>{net.anchor} is not in an account group. <Link to="/app/connections/groups" className="link-accent">Add it to a group</Link> to plan a network.</>}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
            {net.resources.map((r) => <ResourceChip key={r.ref} refId={r.ref} />)}
          </div>
        </div>
        <NetworkModeSwitch handle={handle} orchestrator={orchestrator} net={net} hasActive={hasActive} grouped={grouped} />
      </div>
    </section>
  );
}

function NetworkModeSwitch({ handle, orchestrator, net, hasActive, grouped }: { handle: string; orchestrator: string; net: AgentNetwork; hasActive: boolean; grouped: boolean }) {
  const confirm = useConfirm();
  const set = useSetNetworkMode(handle);
  const name = net.groupName ?? 'the network';

  const choose = async (mode: 'mirror' | 'orchestrated') => {
    if (mode === net.mode || set.isPending) return;
    const ok = mode === 'orchestrated'
      ? await confirm(`switch «${name}» to orchestrated`, {
        danger: false, confirmLabel: 'Orchestrate',
        details: (
          <div className="callout-warning" style={{ flexDirection: 'column', gap: 6 }}>
            <strong>@{orchestrator} will plan native posts for every resource of the group.</strong>
            <span className="text-micro">Each platform gets its own formats, cadence and wording from the active playbook. Mirroring of Telegram posts to the group stops for this network. The agents keep their own mode — in shadow nothing is published.</span>
          </div>
        ),
      })
      : await confirm(`switch «${name}» back to mirror`, {
        danger: false, confirmLabel: 'Mirror',
        details: <p className="text-micro" style={{ margin: 0, color: 'var(--color-ink-muted)' }}>The orchestrator stops planning the other platforms; Telegram posts are mirrored to the group again.</p>,
      });
    if (!ok) return;
    set.mutate(mode, {
      onSuccess: (r) => toast.success(`«${r.group}» → ${r.mode}`),
      onError: (e) => toast.error(errorText(e)),
    });
  };

  const opt = (key: 'mirror' | 'orchestrated', label: string, disabledWhy: string | null) => {
    const selected = net.mode === key;
    return (
      <button key={key} type="button" role="tab" aria-selected={selected} disabled={!!disabledWhy || set.isPending}
        title={disabledWhy ?? undefined} onClick={() => choose(key)}
        className={`tabs-pill-item is-sm${selected ? ' is-selected' : ''}`}>
        {label}
      </button>
    );
  };
  const noNet = grouped ? null : 'This channel is not in an account group';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
      <span className="text-micro" style={eyebrow}>Network mode</span>
      <div className="tabs-pill" role="tablist" title={noNet ?? undefined}>
        {opt('mirror', 'Mirror', noNet)}
        {opt('orchestrated', 'Orchestrated', noNet ?? (hasActive || net.mode === 'orchestrated' ? null : 'Approve a playbook first'))}
      </div>
      {grouped && !hasActive && net.mode !== 'orchestrated' && (
        <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>needs an active playbook</span>
      )}
    </div>
  );
}

// ── pending version ──

function PendingCard({ row, active }: { row: PlaybookRow; active: PlaybookRow | null }) {
  const confirm = useConfirm();
  const decide = useDecidePlaybook();
  const [full, setFull] = useState(false);
  const diff = diffPlaybooks(active?.body, row.body);

  const go = async (decision: 'approve' | 'reject') => {
    const ok = decision === 'approve'
      ? await confirm(`approve playbook v${row.version}`, {
        danger: false, confirmLabel: 'Approve',
        details: <p className="text-micro" style={{ margin: 0, color: 'var(--color-ink-muted)' }}>It becomes the active playbook at once{active ? `; v${active.version} is superseded` : ''}. The next plan follows it.</p>,
      })
      : await confirm(`reject playbook v${row.version}`, { confirmLabel: 'Reject' });
    if (!ok) return;
    decide.mutate({ id: row.id, decision }, {
      onSuccess: () => toast.success(decision === 'approve' ? `v${row.version} is active` : `v${row.version} rejected`),
      onError: (e) => toast.error(errorText(e) === 'not pending' ? 'This version is no longer pending' : errorText(e)),
    });
  };

  return (
    <SectionCard
      title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>Pending <Badge tone="warning">v{row.version}</Badge></span>}
      icon="inbox" delay={20}
      style={{ marginBottom: 16, boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-warning) 40%, transparent)' }}
      action={<Badge tone="warning">awaiting approval</Badge>}
    >
      <VersionMeta row={row} />
      {row.brief && (
        <details style={{ marginBottom: 12 }}>
          <summary className="text-micro" style={{ cursor: 'pointer', color: 'var(--color-ink-muted)' }}>Brief</summary>
          <p className="text-body-sm" style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', color: 'var(--color-ink)' }}>{row.brief}</p>
        </details>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', gap: 14, marginBottom: 12 }}>
        <div className="card" style={{ padding: '12px 14px', minWidth: 0 }}>
          <div className="text-micro" style={eyebrow}>Reviewer</div>
          <ReviewBlock review={row.review} />
        </div>
        <div className="card" style={{ padding: '12px 14px', minWidth: 0 }}>
          <div className="text-micro" style={eyebrow}>{active ? `Changes vs v${active.version}` : 'Contents'}</div>
          <DiffSummary groups={diff} empty={active ? 'Same as the active version.' : 'First version.'} />
        </div>
      </div>

      <button type="button" className="btn-ghost text-micro" style={{ ...btn, padding: '4px 0' }} onClick={() => setFull((v) => !v)} aria-expanded={full}>
        <Icon name={full ? 'chevron-up' : 'chevron-down'} size={13} /> {full ? 'Hide' : 'Show'} the full v{row.version}
      </button>
      {full && <div style={{ marginTop: 12 }}><PlaybookView body={row.body} /></div>}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <button type="button" className="btn-secondary" style={{ ...btn, color: 'var(--color-danger)' }} disabled={decide.isPending} onClick={() => go('reject')}>
          <Icon name="x" size={14} /> Reject
        </button>
        <button type="button" className="btn-primary" style={btn} disabled={decide.isPending} onClick={() => go('approve')}>
          <Icon name="check" size={14} /> Approve
        </button>
      </div>
    </SectionCard>
  );
}

function ReviewBlock({ review }: { review: PlaybookRow['review'] }) {
  if (!review) return <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>No review yet.</span>;
  return (
    <div>
      <Badge tone={review.verdict === 'ok' ? 'success' : 'warning'}>{review.verdict === 'ok' ? 'ok' : 'concerns'}</Badge>
      {review.comments.length > 0 ? (
        <ul style={{ margin: '8px 0 0', paddingLeft: 16, listStyle: 'disc', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {review.comments.map((c, i) => <li key={i} className="text-micro" style={{ color: 'var(--color-ink)', overflowWrap: 'anywhere', lineHeight: 1.5 }}>{c}</li>)}
        </ul>
      ) : <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginTop: 6 }}>No comments.</div>}
    </div>
  );
}

const MARK = { added: { c: '+', color: 'var(--color-success)' }, removed: { c: '−', color: 'var(--color-danger)' }, changed: { c: '~', color: 'var(--color-warning)' } } as const;

export function DiffSummary({ groups, empty }: { groups: DiffGroup[]; empty: string }) {
  if (!groups.length) return <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{empty}</span>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {groups.map((g) => (
        <div key={g.key} style={{ minWidth: 0 }}>
          <div className="text-body-sm" style={{ marginBottom: 3 }}>
            {g.refId ? <ResourceLabel refId={g.refId} strong /> : <span style={{ color: 'var(--color-ink)', fontWeight: 500 }}>{g.title}</span>}
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {g.changes.map((c, i) => (
              <li key={i} className="text-micro" style={{ display: 'flex', gap: 6, color: 'var(--color-ink-muted)', minWidth: 0 }}>
                <span aria-label={c.kind} style={{ color: MARK[c.kind].color, fontWeight: 600, width: 10, flexShrink: 0, textAlign: 'center' }}>{MARK[c.kind].c}</span>
                <span style={{ overflowWrap: 'anywhere', minWidth: 0 }}>{c.text}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ── read-only render ──

const ROLE_TONE: Record<string, 'success' | 'accent' | 'neutral' | 'warning'> = { core: 'success', discovery: 'warning', community: 'neutral', archive: 'neutral' };

function RoleChip({ role }: { role: string }) {
  if (role.startsWith('funnel_to:')) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, maxWidth: '100%' }}>
        <Badge tone="neutral">funnel →</Badge>
        <ResourceChip refId={role.slice('funnel_to:'.length)} />
      </span>
    );
  }
  return <Badge tone={ROLE_TONE[role] ?? 'neutral'}>{role}</Badge>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '78px minmax(0, 1fr)', gap: 8, alignItems: 'baseline' }}>
      <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{label}</span>
      <span style={{ color: 'var(--color-ink)', minWidth: 0, overflowWrap: 'anywhere', fontSize: 12.5, lineHeight: 1.45 }}>{children}</span>
    </div>
  );
}

function PlatformCard({ s, delay }: { s: PlaybookPlatform; delay: number }) {
  const formats = Object.entries(s.formats).sort((a, b) => b[1] - a[1]);
  const hp = s.hashtag_policy ?? { vocab: [], min: 0, max: 0 };
  return (
    <div className="card compose-rise" style={{ padding: '14px 16px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12, animationDelay: `${delay}ms` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
        <span style={{ flex: '1 1 auto', minWidth: 0, display: 'flex' }}><ResourceLabel refId={s.resource_ref} strong /></span>
        <RoleChip role={s.role} />
      </div>
      <div>
        <div className="text-micro" style={eyebrow}>Formats</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {formats.length ? formats.map(([f, v]) => <WeightBar key={f} label={f} value={v} />) : <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>none</span>}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Row label="Per day"><span className="tabular-nums">{s.per_day.min === s.per_day.max ? s.per_day.min : `${s.per_day.min}–${s.per_day.max}`} posts</span></Row>
        <Row label="Best hours">
          {s.best_hours?.length
            ? <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>{[...s.best_hours].sort((a, b) => a - b).map((h) => <span key={h} className="chip tabular-nums" style={{ fontSize: 11 }}>{hourLabel(h)}</span>)}</span>
            : <span style={{ color: 'var(--color-ink-dim)' }}>any</span>}
        </Row>
        {s.tone && <Row label="Tone"><span style={{ color: 'var(--color-ink-muted)' }}>{s.tone}</span></Row>}
        <Row label="Hashtags">
          <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            {hp.vocab.map((t) => <span key={t} className="chip" style={{ fontSize: 11 }}>{t}</span>)}
            <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-dim)' }}>{hp.max === 0 ? 'none' : `${hp.min}–${hp.max} per post`}</span>
          </span>
        </Row>
        {s.link_policy && <Row label="Links">{s.link_policy}</Row>}
        {s.cta && <Row label="CTA">{s.cta}</Row>}
      </div>
    </div>
  );
}

// Pillar segments: the accent at decreasing strength, so the bar stays one hue.
const PILLAR_ALPHA = [0.95, 0.72, 0.52, 0.38, 0.27, 0.19, 0.14, 0.1];

export function PlaybookView({ body }: { body: Playbook }) {
  const total = body.pillars.reduce((s, p) => s + p.share, 0) || 1;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 290px), 1fr))', gap: 12 }}>
        {body.platforms.map((s, i) => <PlatformCard key={s.resource_ref} s={s} delay={i * 30} />)}
      </div>

      {body.series.length > 0 && (
        <div>
          <div className="text-micro" style={eyebrow}>Series</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {body.series.map((s) => (
              <div key={s.name} className="card" style={{ padding: '10px 14px', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start', opacity: s.active ? 1 : 0.6 }}>
                <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ color: 'var(--color-ink)', fontWeight: 500 }}>{s.name}</span>
                    {!s.active && <Badge tone="neutral">paused</Badge>}
                  </div>
                  <div className="text-micro" style={{ color: 'var(--color-ink-muted)', marginTop: 3, overflowWrap: 'anywhere' }}>{s.brief}</div>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="chip tabular-nums"><Icon name="clock" size={11} />&nbsp;{fmtCadence(s.cadence)}</span>
                  <ResourceChip refId={s.resource_ref} suffix={s.format} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {body.pillars.length > 0 && (
        <div>
          <div className="text-micro" style={eyebrow}>Topic pillars</div>
          <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: 'var(--color-surface-3)', gap: 2 }} aria-hidden>
            {body.pillars.map((p, i) => (
              <span key={p.name} title={`${p.name} · ${p.share}%`}
                style={{ width: `${(p.share / total) * 100}%`, background: `color-mix(in srgb, var(--color-accent) ${Math.round(PILLAR_ALPHA[i % PILLAR_ALPHA.length] * 100)}%, transparent)` }} />
            ))}
          </div>
          <div style={{ display: 'flex', gap: '4px 14px', flexWrap: 'wrap', marginTop: 8 }}>
            {body.pillars.map((p, i) => (
              <span key={p.name} className="text-micro" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-ink-muted)' }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: `color-mix(in srgb, var(--color-accent) ${Math.round(PILLAR_ALPHA[i % PILLAR_ALPHA.length] * 100)}%, transparent)` }} />
                <span style={{ color: 'var(--color-ink)' }}>{p.name}</span>
                <span className="tabular-nums">{p.share}%</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {body.rules.length > 0 && (
        <div>
          <div className="text-micro" style={eyebrow}>Rules</div>
          <ol style={{ margin: 0, paddingLeft: 20, listStyle: 'decimal', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {body.rules.map((r, i) => <li key={i} className="text-body-sm" style={{ color: 'var(--color-ink)', overflowWrap: 'anywhere' }}>{r}</li>)}
          </ol>
        </div>
      )}
    </div>
  );
}

// ── history ──

function HistoryCard({ rows, onOpen }: { rows: PlaybookRow[]; onOpen: (r: PlaybookRow) => void }) {
  const sorted = [...rows].sort((a, b) => b.version - a.version);
  return (
    <SectionCard title="History" icon="history" delay={60}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {sorted.map((r, i) => (
          <button key={r.id} type="button" className="card row-lift compose-rise" onClick={() => onOpen(r)}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', textAlign: 'left', cursor: 'pointer', color: 'inherit', font: 'inherit', width: '100%', flexWrap: 'wrap', animationDelay: `${i * 25}ms` }}>
            <span className="tabular-nums" style={{ fontWeight: 600, color: 'var(--color-ink)', width: 32 }}>v{r.version}</span>
            <Badge tone={PLAYBOOK_TONE[r.status]}>{r.status.replace('_', ' ')}</Badge>
            <span className="chip" style={{ fontSize: 11 }}>{r.createdBy}</span>
            <span className="text-micro" style={{ flex: '1 1 160px', minWidth: 0, color: 'var(--color-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.rationale ?? undefined}>
              {r.rationale ?? '—'}
            </span>
            <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-dim)', whiteSpace: 'nowrap' }}>{fmtDate(r.createdAt)}</span>
          </button>
        ))}
      </div>
    </SectionCard>
  );
}

function HistoryModal({ row, history, onClose }: { row: PlaybookRow; history: PlaybookRow[]; onClose: () => void }) {
  const prev = [...history].filter((h) => h.version < row.version).sort((a, b) => b.version - a.version)[0] ?? null;
  return (
    <Modal open onClose={onClose} size="xl" icon="logs" title={`Playbook v${row.version}`}
      subtitle={`${row.status.replace('_', ' ')} · by ${row.createdBy} · ${fmtDate(row.createdAt)}${row.decidedAt ? ` · decided ${fmtDate(row.decidedAt)}` : ''}`}>
      {row.rationale && <p className="text-body-sm" style={{ margin: '0 0 12px', color: 'var(--color-ink)', whiteSpace: 'pre-wrap' }}>{row.rationale}</p>}
      {row.brief && (
        <details style={{ marginBottom: 12 }}>
          <summary className="text-micro" style={{ cursor: 'pointer', color: 'var(--color-ink-muted)' }}>Brief</summary>
          <p className="text-body-sm" style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', color: 'var(--color-ink)' }}>{row.brief}</p>
        </details>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 12, marginBottom: 16 }}>
        {row.review && (
          <div className="card" style={{ padding: '12px 14px', minWidth: 0 }}>
            <div className="text-micro" style={eyebrow}>Reviewer</div>
            <ReviewBlock review={row.review} />
          </div>
        )}
        <div className="card" style={{ padding: '12px 14px', minWidth: 0 }}>
          <div className="text-micro" style={eyebrow}>{prev ? `Changes vs v${prev.version}` : 'Changes'}</div>
          <DiffSummary groups={diffPlaybooks(prev?.body, row.body)} empty={prev ? `Same as v${prev.version}.` : 'First version.'} />
        </div>
      </div>
      <PlaybookView body={row.body} />
      <div className="modal-foot"><button type="button" className="btn-secondary" onClick={onClose}>Close</button></div>
    </Modal>
  );
}

// ── rebuild ──

function RebuildModal({ handle, hasActive, onClose }: { handle: string; hasActive: boolean; onClose: () => void }) {
  const rebuild = useRebuildPlaybook(handle);
  const [brief, setBrief] = useState('');
  const start = async () => {
    try {
      await rebuild.mutateAsync(brief);
      toast.success('Rebuild started — a new version will wait for your approval');
      onClose();
    } catch { /* shown inline */ }
  };
  return (
    <Modal open onClose={onClose} size="lg" icon="sparkles" title="Rebuild from brief"
      subtitle="The orchestrator drafts a new playbook version in the background; the reviewer checks it and it waits here for your approval.">
      <label className="text-eyebrow" htmlFor="pb-brief" style={{ display: 'block', marginBottom: 6 }}>Brief</label>
      <textarea id="pb-brief" className="input-field" value={brief} maxLength={4000} onChange={(e) => setBrief(e.target.value)}
        placeholder="Напр.: більше коротких відео в TikTok, Instagram — каруселі з фактами, щонеділі дайджест тижня в Telegram…"
        style={{ width: '100%', boxSizing: 'border-box', minHeight: 140, resize: 'vertical', fontFamily: 'inherit' }} />
      <div className="text-micro" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 6, color: 'var(--color-ink-dim)', flexWrap: 'wrap' }}>
        <span>Leave empty to rebuild from the channel card's brief{hasActive ? ' and the current playbook' : ''}.</span>
        <span className="tabular-nums">{brief.length} / 4000</span>
      </div>
      {rebuild.error && <div className="callout-danger" style={{ marginTop: 10 }}>{errorText(rebuild.error)}</div>}
      <div className="modal-foot">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" style={btn} disabled={rebuild.isPending} onClick={start}>
          <Icon name="sparkles" size={14} /> {rebuild.isPending ? 'Starting…' : 'Start rebuild'}
        </button>
      </div>
    </Modal>
  );
}
