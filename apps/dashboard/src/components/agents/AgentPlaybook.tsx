// Playbook tab of /app/agents/$handle (spec 020 FR-011): the network header
// with the independent / auto-duplicate switch, the pending version awaiting approval
// (reviewer verdict + a diff vs the active one), the active playbook rendered
// per resource, "Rebuild from brief", the owner editor and version history.
// Compact: the pending version is a one-line card whose dialog holds the review, the
// diff, the brief, the full version and Approve / Reject; each platform section, series
// and example post is a compact card whose dialog has the rest.
// Spec 078 D2: classes of agent-playbook.css (prefix apb-); the layout of a tab is a stack of panels.

import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { EmptyState, SectionCard } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { CompactCard } from '../ui/CompactCard';
import { useConfirm } from '../ui/ConfirmDialog';
import { toast } from '../ui/Toast';
import { Modal } from '../Modal';
import { fmtDate, fmtRelative } from '../../lib/format';
import {
  useAgentNetwork, useDecidePlaybook, usePlaybook, useRebuildPlaybook, useSetNetworkMode,
  type AgentNetwork, type Playbook, type PlaybookExample, type PlaybookPlatform, type PlaybookRow, type PlaybookSeries, type GroupNetworkMode,
} from '../../api/network';
import {
  NETWORK_MODE_LABEL, NETWORK_MODE_TONE, NetworkError, PLAYBOOK_TONE, ResourceChip, ResourceLabel, WeightBar, errorText, fmtCadence, hourLabel,
} from './NetworkUi';
import { diffPlaybooks, type DiffGroup } from './playbookDiff';
import { PlaybookEditor } from './PlaybookEditor';

/** Spec 034 FR-007: more enabled formats than this in one section is flagged (the server warns too). */
const MAX_FITTING_FORMATS = 4;

export function AgentPlaybook({ handle, orchestrator }: { handle: string; orchestrator: string }) {
  const net = useAgentNetwork(handle);
  const pb = usePlaybook(handle);
  const [editing, setEditing] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [viewing, setViewing] = useState<PlaybookRow | null>(null);

  if (pb.error) return <NetworkError error={pb.error} />;
  if (!pb.data) return <div className="apb-skeleton" style={{ height: 160 }} aria-hidden />;
  const { active, pending, history } = pb.data;

  const rebuildBtn = (
    <button type="button" className="btn-secondary" onClick={() => setRebuilding(true)}>
      <Icon name="sparkles" size={14} /> Rebuild from brief
    </button>
  );

  return (
    <div className="apb-stack">
      <NetworkHeader handle={handle} orchestrator={orchestrator} net={net.data ?? null} error={net.error} hasActive={!!active} />

      {pending && <PendingCard row={pending} active={active} />}

      {active ? (
        <SectionCard
          title={<span className="apb-title">Active playbook <Badge tone="success">v{active.version}</Badge></span>}
          icon="logs" delay={40}
          action={(
            <span className="apb-actions">
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
        <div className="compose-rise">
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
    <div className="apb-meta">
      <span>by {row.createdBy}</span>
      <span aria-hidden>·</span>
      <span className="mono" title={fmtDate(row.createdAt)}>{fmtRelative(row.createdAt)}</span>
      {row.rationale && <><span aria-hidden>·</span><span className="apb-meta-why">{row.rationale}</span></>}
    </div>
  );
}

// ── network header + mode switch ──

function NetworkHeader({ handle, orchestrator, net, error, hasActive }: { handle: string; orchestrator: string; net: AgentNetwork | null; error: unknown; hasActive: boolean }) {
  if (error) return <NetworkError error={error} />;
  if (!net) return <div className="apb-skeleton" style={{ height: 88 }} aria-hidden />;
  const grouped = !!net.groupId && net.mode !== 'single';
  return (
    <section className="panel is-section compose-rise apb-net" aria-label="Network">
      <span className="section-glyph"><Icon name="agents" size={15} /></span>
      <div className="apb-net-main">
        <div className="apb-title">
          <h2 className="text-heading-md">{grouped ? net.groupName ?? 'Network' : 'No network'}</h2>
          <Badge tone={NETWORK_MODE_TONE[net.mode]}>{NETWORK_MODE_LABEL[net.mode]}</Badge>
        </div>
        <p className="apb-net-text">
          {grouped
            ? net.mode === 'independent'
              ? <>Each member is its own resource; the orchestrator of <strong>{net.anchor}</strong> decides per post: duplicate, adapt, unique or skip.{net.autoDuplicateActive !== false ? ' Telegram posts are still auto-duplicated today.' : ''}</>
              : <>Telegram posts of <strong>{net.anchor}</strong> are auto-duplicated to the group.</>
            : <>{net.anchor} is not in an account group. <Link to="/app/connections/groups" className="link-accent">Add it to a group</Link> to plan a network.</>}
        </p>
        <div className="apb-chips">
          {net.resources.map((r) => <ResourceChip key={r.ref} refId={r.ref} />)}
        </div>
      </div>
      <NetworkModeSwitch handle={handle} orchestrator={orchestrator} net={net} hasActive={hasActive} grouped={grouped} />
    </section>
  );
}

function NetworkModeSwitch({ handle, orchestrator, net, hasActive, grouped }: { handle: string; orchestrator: string; net: AgentNetwork; hasActive: boolean; grouped: boolean }) {
  const confirm = useConfirm();
  const set = useSetNetworkMode(handle);
  const name = net.groupName ?? 'the network';

  const choose = async (mode: GroupNetworkMode) => {
    if (mode === net.mode || set.isPending) return;
    const ok = mode === 'independent'
      ? await confirm(`switch «${name}» to independent`, {
        danger: false, confirmLabel: 'Switch to independent',
        details: (
          <div className="callout-warning apb-callout-col">
            <strong>Each member becomes its own resource; @{orchestrator} decides per post: duplicate, adapt, unique or skip.</strong>
            <span className="text-micro">In shadow the agent records decisions as previews and auto-duplication continues; it stops from the next plan day once the agent is live with an active playbook.{hasActive ? '' : ' Until a playbook is approved only Telegram is planned.'}</span>
          </div>
        ),
      })
      : await confirm(`switch «${name}» to auto-duplicate (legacy)`, {
        danger: false, confirmLabel: 'Auto-duplicate',
        details: <p className="text-micro apb-note">The orchestrator stops planning the other platforms; Telegram posts are auto-duplicated to the group again from the next plan day.</p>,
      });
    if (!ok) return;
    set.mutate(mode, {
      onSuccess: (r) => toast.success(`«${r.group}» → ${r.mode}`),
      onError: (e) => toast.error(errorText(e)),
    });
  };

  const opt = (key: GroupNetworkMode, label: string, disabledWhy: string | null) => {
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
    <div className="apb-mode">
      <span className="text-overline">Network mode</span>
      <div className="tabs-pill" role="tablist" aria-label="Network mode" title={noNet ?? undefined}>
        {opt('legacy_duplicate', 'Auto-duplicate (legacy)', noNet)}
        {opt('independent', 'Independent', noNet)}
      </div>
      {grouped && !hasActive && net.mode === 'independent' && (
        <span className="text-micro apb-dim">no active playbook: Telegram only</span>
      )}
    </div>
  );
}

// ── pending version ──

/** The version awaiting approval as a one-line card; its dialog has the review, the diff, the brief, the full version and the decision. */
function PendingCard({ row, active }: { row: PlaybookRow; active: PlaybookRow | null }) {
  const diff = diffPlaybooks(active?.body, row.body);
  const changes = diff.reduce((n, g) => n + g.changes.length, 0);
  const review = row.review;
  return (
    <CompactCard delay={20} attention hint="Open the pending version"
      top={<>
        <Badge tone="warning">v{row.version}</Badge>
        <Badge tone="warning">awaiting approval</Badge>
        {review && <Badge tone={review.verdict === 'ok' ? 'success' : 'warning'} title="Playbook reviewer verdict">reviewer: {review.verdict === 'ok' ? 'ok' : 'concerns'}</Badge>}
      </>}
      meta={<span className="mono" title={fmtDate(row.createdAt)}>{fmtRelative(row.createdAt)}</span>}
      title={`Playbook v${row.version} awaiting approval`}
      body={row.rationale || undefined} lines={1}
      extra={(
        <span className="text-micro apb-dim">
          by {row.createdBy}
          {' · '}{review ? `${review.comments.length} reviewer comment${review.comments.length === 1 ? '' : 's'}` : 'no review yet'}
          {' · '}{active ? `${changes} change${changes === 1 ? '' : 's'} vs v${active.version}` : 'first version'}
        </span>
      )}
      dialog={{
        size: 'xl', icon: 'inbox', title: `Pending playbook v${row.version}`,
        subtitle: `awaiting approval · by ${row.createdBy} · ${fmtDate(row.createdAt)}`,
        body: () => <PendingDetails row={row} active={active} />,
        actions: (close) => <PendingActions row={row} active={active} onDone={close} />,
      }} />
  );
}

/** A titled inset of a dialog: an overline key over its content (the reviewer's verdict, the changes). */
function Fact({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="inset apb-fact">
      <h3 className="text-overline">{title}</h3>
      {children}
    </div>
  );
}

/** A titled block of a dialog or of the playbook view: an overline head (with an optional action) over its content. */
function Block({ title, action, children }: { title: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="apb-block">
      <div className="apb-block-head">
        <h3 className="text-overline">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

function PendingDetails({ row, active }: { row: PlaybookRow; active: PlaybookRow | null }) {
  const diff = diffPlaybooks(active?.body, row.body);
  return (
    <div className="apb-col">
      {row.rationale && <p className="apb-prose">{row.rationale}</p>}
      <div className="apb-split">
        <Fact title="Reviewer"><ReviewBlock review={row.review} /></Fact>
        <Fact title={active ? `Changes vs v${active.version}` : 'Contents'}>
          <DiffSummary groups={diff} empty={active ? 'Same as the active version.' : 'First version.'} />
        </Fact>
      </div>
      {row.brief && <BriefBlock brief={row.brief} />}
      <Block title={`The full v${row.version}`}>
        <PlaybookView body={row.body} />
      </Block>
    </div>
  );
}

function PendingActions({ row, active, onDone }: { row: PlaybookRow; active: PlaybookRow | null; onDone?: () => void }) {
  const confirm = useConfirm();
  const decide = useDecidePlaybook();
  const go = async (decision: 'approve' | 'reject') => {
    const ok = decision === 'approve'
      ? await confirm(`approve playbook v${row.version}`, {
        danger: false, confirmLabel: 'Approve',
        details: <p className="text-micro apb-note">It becomes the active playbook at once{active ? `; v${active.version} is superseded` : ''}. The next plan follows it.</p>,
      })
      : await confirm(`reject playbook v${row.version}`, { confirmLabel: 'Reject' });
    if (!ok) return;
    decide.mutate({ id: row.id, decision }, {
      onSuccess: () => { toast.success(decision === 'approve' ? `v${row.version} is active` : `v${row.version} rejected`); onDone?.(); },
      onError: (e) => toast.error(errorText(e) === 'not pending' ? 'This version is no longer pending' : errorText(e)),
    });
  };
  return (
    <>
      <button type="button" className="btn-secondary apb-reject" disabled={decide.isPending} onClick={() => go('reject')}>
        <Icon name="x" size={14} /> Reject
      </button>
      <button type="button" className="btn-primary" disabled={decide.isPending} onClick={() => go('approve')}>
        <Icon name="check" size={14} /> Approve
      </button>
    </>
  );
}

/** The owner's brief of a version (shown in full inside a dialog). */
function BriefBlock({ brief }: { brief: string }) {
  return (
    <Block title="Brief">
      <p className="apb-prose">{brief}</p>
    </Block>
  );
}

function ReviewBlock({ review }: { review: PlaybookRow['review'] }) {
  if (!review) return <span className="text-micro apb-dim">No review yet.</span>;
  return (
    <div className="apb-review">
      <Badge tone={review.verdict === 'ok' ? 'success' : 'warning'}>{review.verdict === 'ok' ? 'ok' : 'concerns'}</Badge>
      {review.comments.length > 0 ? (
        <ul className="apb-list">
          {review.comments.map((c, i) => <li key={i}>{c}</li>)}
        </ul>
      ) : <span className="text-micro apb-dim">No comments.</span>}
    </div>
  );
}

const MARK = { added: '+', removed: '−', changed: '~' } as const;

export function DiffSummary({ groups, empty }: { groups: DiffGroup[]; empty: string }) {
  if (!groups.length) return <span className="text-micro apb-dim">{empty}</span>;
  return (
    <div className="apb-diff-groups">
      {groups.map((g) => (
        <div key={g.key} className="apb-diff-group">
          <div className="apb-diff-title">
            {g.refId ? <ResourceLabel refId={g.refId} strong /> : <span>{g.title}</span>}
          </div>
          <ul className="apb-diff-list">
            {g.changes.map((c, i) => (
              <li key={i}>
                <span className={`apb-diff-mark is-${c.kind}`} aria-label={c.kind}>{MARK[c.kind]}</span>
                <span className="apb-diff-text">{c.text}</span>
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
      <span className="apb-funnel">
        <Badge tone="neutral">funnel →</Badge>
        <ResourceChip refId={role.slice('funnel_to:'.length)} />
      </span>
    );
  }
  return <Badge tone={ROLE_TONE[role] ?? 'neutral'}>{role}</Badge>;
}

/** One key / value line of a facts inset: an overline key and the value. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="apb-fact-row">
      <span className="text-overline">{label}</span>
      <span className="apb-fact-value">{children}</span>
    </div>
  );
}

/** "photo 40 · text 30 · +2": the top enabled formats by weight (in %). */
function formatsLine(formats: Record<string, number>, top = 3): string {
  const enabled = Object.entries(formats).filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]);
  if (!enabled.length) return 'no formats';
  const shown = enabled.slice(0, top).map(([f, w]) => `${f} ${Math.round(w * 100)}`);
  return `${shown.join(' · ')}${enabled.length > top ? ` · +${enabled.length - top}` : ''}`;
}

const perDayLabel = (s: PlaybookPlatform) => (s.per_day.min === s.per_day.max ? `${s.per_day.min}` : `${s.per_day.min}–${s.per_day.max}`);

/** One resource's section as a compact card: resource, role, top formats, posts per day, best hours; the dialog has the full section. */
function PlatformCard({ s, delay }: { s: PlaybookPlatform; delay: number }) {
  const enabled = Object.values(s.formats).filter((w) => w > 0).length;
  const hours = s.best_hours?.length ?? 0;
  return (
    <CompactCard delay={delay} hint="Open the section"
      top={<>
        <span className="apb-grow"><ResourceLabel refId={s.resource_ref} strong /></span>
        <RoleChip role={s.role} />
      </>}
      body={<span className="tabular-nums">{formatsLine(s.formats)}</span>} lines={1}
      extra={(
        <span className="text-micro tabular-nums apb-dim">
          {perDayLabel(s)} post{s.per_day.max === 1 ? '' : 's'}/day · {hours ? `${hours} best hour${hours === 1 ? '' : 's'}` : 'any hour'}
        </span>
      )}
      note={enabled > MAX_FITTING_FORMATS ? `${enabled} formats enabled — keep ${MAX_FITTING_FORMATS} or fewer` : undefined}
      dialog={{
        size: 'lg', icon: 'logs', title: s.resource_ref, subtitle: `role ${s.role.replace('funnel_to:', 'funnel → ')}`,
        body: () => <PlatformDetails s={s} />,
      }} />
  );
}

function PlatformDetails({ s }: { s: PlaybookPlatform }) {
  const formats = Object.entries(s.formats).sort((a, b) => b[1] - a[1]);
  const enabled = formats.filter(([, w]) => w > 0).map(([f]) => f);
  const reasons = enabled.filter((f) => s.format_reasons?.[f]).map((f) => [f, s.format_reasons![f]] as const);
  const hp = s.hashtag_policy ?? { vocab: [], min: 0, max: 0 };
  return (
    <div className="apb-col">
      <div className="apb-lead">
        <span className="apb-grow"><ResourceLabel refId={s.resource_ref} strong /></span>
        <RoleChip role={s.role} />
      </div>
      <Block title="Formats">
        <div className="apb-weights">
          {formats.length ? formats.map(([f, v]) => <WeightBar key={f} label={f} value={v} />) : <span className="text-micro apb-dim">none</span>}
        </div>
        {/* Spec 034 FR-007: why each format fits; more than 4 enabled formats is flagged. */}
        {enabled.length > MAX_FITTING_FORMATS && (
          <div className="text-micro apb-warn apb-gap-top">
            ⚠ {enabled.length} formats enabled: keep the {MAX_FITTING_FORMATS} or fewer that fit the topic and audience
          </div>
        )}
        {reasons.length > 0 && (
          <ul className="apb-reasons">
            {reasons.map(([f, r]) => (
              <li key={f} className="text-micro">
                <span className="apb-ink">{f}</span>: {r}
              </li>
            ))}
          </ul>
        )}
      </Block>
      <div className="inset apb-facts">
        <Row label="Per day"><span className="tabular-nums">{perDayLabel(s)} posts</span></Row>
        <Row label="Best hours">
          {s.best_hours?.length
            ? <span className="apb-chips">{[...s.best_hours].sort((a, b) => a - b).map((h) => <span key={h} className="chip mono tabular-nums">{hourLabel(h)}</span>)}</span>
            : <span className="apb-dim">any</span>}
        </Row>
        {s.tone && <Row label="Tone"><span className="apb-muted">{s.tone}</span></Row>}
        <Row label="Hashtags">
          <span className="apb-chips">
            {hp.vocab.map((t) => <span key={t} className="chip">{t}</span>)}
            <span className="text-micro tabular-nums apb-dim">{hp.max === 0 ? 'none' : `${hp.min}–${hp.max} per post`}</span>
          </span>
        </Row>
        {s.link_policy && <Row label="Links">{s.link_policy}</Row>}
        {s.cta && <Row label="CTA">{s.cta}</Row>}
      </div>
    </div>
  );
}

/** A series as a compact card: name, cadence, resource, active; the dialog has the full brief. */
function SeriesCard({ s, delay }: { s: PlaybookSeries; delay: number }) {
  return (
    // The wrapper carries the dim of a paused series: the card's own entrance animation ends at full opacity.
    <div className={s.active ? undefined : 'apb-paused'}>
      <CompactCard delay={delay} hint="Open the series"
        top={<>
          {s.active ? <Badge tone="success">active</Badge> : <Badge tone="neutral">paused</Badge>}
          <span className="chip mono tabular-nums"><Icon name="clock" size={11} />&nbsp;{fmtCadence(s.cadence)}</span>
        </>}
        title={s.name}
        body={s.brief || undefined} lines={1}
        extra={<span className="apb-row"><ResourceChip refId={s.resource_ref} suffix={s.format} /></span>}
        dialog={{
          size: 'md', icon: 'history', title: s.name, subtitle: `${fmtCadence(s.cadence)} · ${s.active ? 'active' : 'paused'}`,
          body: () => (
            <div className="apb-col">
              <div className="apb-chips">
                {s.active ? <Badge tone="success">active</Badge> : <Badge tone="neutral">paused</Badge>}
                <span className="chip mono tabular-nums"><Icon name="clock" size={11} />&nbsp;{fmtCadence(s.cadence)}</span>
                <ResourceChip refId={s.resource_ref} suffix={s.format} />
              </div>
              <Block title="Brief">
                <p className="apb-prose">{s.brief || '—'}</p>
              </Block>
            </div>
          ),
        }} />
    </div>
  );
}

// Pillar segments: the accent at decreasing strength, so the bar stays one hue.
const PILLAR_ALPHA = [0.95, 0.72, 0.52, 0.38, 0.27, 0.19, 0.14, 0.1];
/** The CSS variables of pillar i: its share (the flex weight) and its accent strength; `.apb-pillar` paints from them. */
const pillarVars = (share: number, i: number) => ({
  ['--apb-share' as string]: share,
  ['--apb-alpha' as string]: `${Math.round(PILLAR_ALPHA[i % PILLAR_ALPHA.length] * 100)}%`,
});

export function PlaybookView({ body }: { body: Playbook }) {
  return (
    <div className="apb-view">
      <Block title={`Resources · ${body.platforms.length}`}>
        <div className="compact-grid">
          {body.platforms.map((s, i) => <PlatformCard key={s.resource_ref} s={s} delay={i * 30} />)}
        </div>
      </Block>

      {body.series.length > 0 && (
        <Block title={`Series · ${body.series.length}`}>
          <div className="compact-grid">
            {body.series.map((s, i) => <SeriesCard key={s.name} s={s} delay={Math.min(i, 12) * 25} />)}
          </div>
        </Block>
      )}

      {body.pillars.length > 0 && (
        <Block title="Topic pillars">
          <div className="apb-bar" aria-hidden>
            {body.pillars.map((p, i) => (
              <span key={p.name} className="apb-pillar" title={`${p.name} · ${p.share}%`} style={pillarVars(p.share, i)} />
            ))}
          </div>
          <div className="apb-legend">
            {body.pillars.map((p, i) => (
              <span key={p.name} className="text-micro apb-legend-item">
                <span className="apb-swatch apb-pillar" style={pillarVars(p.share, i)} />
                <span className="apb-ink">{p.name}</span>
                <span className="mono tabular-nums">{p.share}%</span>
              </span>
            ))}
          </div>
        </Block>
      )}

      {body.rules.length > 0 && <RulesList rules={body.rules} />}

      {(body.examples?.length ?? 0) > 0 && <ExamplesList examples={body.examples!} />}
    </div>
  );
}

/** Spec 034 FR-008: the owner-approved example posts (the writer's few-shot) and bad-post warnings (the critic's reference). */
function ExamplesList({ examples }: { examples: PlaybookExample[] }) {
  const sorted = [...examples].sort((a, b) => Number(a.verdict === 'bad') - Number(b.verdict === 'bad'));
  return (
    <Block title={`Example posts · ${examples.filter((e) => e.verdict === 'good').length} good, ${examples.filter((e) => e.verdict === 'bad').length} to avoid`}>
      <div className="compact-grid">
        {sorted.map((e, i) => <ExampleCard key={i} e={e} delay={Math.min(i, 12) * 25} />)}
      </div>
    </Block>
  );
}

/** One example post: verdict, format and the first lines; the dialog has the full text and the note. */
function ExampleCard({ e, delay }: { e: PlaybookExample; delay: number }) {
  const good = e.verdict === 'good';
  return (
    <CompactCard delay={delay} hint="Open the example post"
      top={<>
        <Badge tone={good ? 'success' : 'danger'}>{good ? 'good' : 'avoid'}</Badge>
        <span className="chip mono">{e.format}</span>
        {e.resource_ref && <ResourceChip refId={e.resource_ref} />}
      </>}
      body={e.text}
      dialog={{
        size: 'lg', icon: 'logs', title: good ? 'Example post' : 'Post to avoid', subtitle: `${e.format}${e.resource_ref ? ` · ${e.resource_ref}` : ''}`,
        body: () => (
          <div className="apb-col">
            <div className="apb-chips">
              <Badge tone={good ? 'success' : 'danger'}>{good ? 'good' : 'avoid'}</Badge>
              <span className="chip mono">{e.format}</span>
              {e.resource_ref && <ResourceChip refId={e.resource_ref} />}
            </div>
            <p className="apb-prose">{e.text}</p>
            {e.note && (
              <Block title="Note">
                <p className="apb-prose apb-muted">{e.note}</p>
              </Block>
            )}
          </div>
        ),
      }} />
  );
}

/** The playbook rules, each clamped to two lines; when one is long, "All rules" opens them in full. */
function RulesList({ rules }: { rules: string[] }) {
  const [open, setOpen] = useState(false);
  const long = rules.some((r) => r.length > 180 || r.includes('\n'));
  const list = (clamp: boolean) => (
    <ol className={`apb-rules${clamp ? '' : ' is-full'}`}>
      {rules.map((r, i) => (
        <li key={i}>
          {clamp ? <span className="clamp" title={r}>{r}</span> : r}
        </li>
      ))}
    </ol>
  );
  return (
    <Block title={`Rules · ${rules.length}`}
      action={long ? <button type="button" className="btn-tiny" onClick={() => setOpen(true)}>All rules</button> : undefined}>
      {list(true)}
      <Modal open={open} onClose={() => setOpen(false)} size="lg" icon="logs" title="Rules" subtitle={`${rules.length} rule${rules.length === 1 ? '' : 's'}`}>
        {list(false)}
      </Modal>
    </Block>
  );
}

// ── history ──

function HistoryCard({ rows, onOpen }: { rows: PlaybookRow[]; onOpen: (r: PlaybookRow) => void }) {
  const sorted = [...rows].sort((a, b) => b.version - a.version);
  return (
    <SectionCard title="History" icon="history" flush delay={60}
      action={<span className="text-micro mono apb-dim">{sorted.length} version{sorted.length === 1 ? '' : 's'}</span>}>
      {sorted.map((r) => (
        <button key={r.id} type="button" className="panel-row apb-hist" onClick={() => onOpen(r)} aria-label={`Open playbook v${r.version}`}>
          <span className="apb-hist-ver mono">v{r.version}</span>
          <Badge tone={PLAYBOOK_TONE[r.status]}>{r.status.replace('_', ' ')}</Badge>
          <span className="chip">{r.createdBy}</span>
          <span className="apb-hist-note clamp" title={r.rationale ?? undefined}>{r.rationale ?? '—'}</span>
          <span className="apb-hist-date mono">{fmtDate(r.createdAt)}</span>
        </button>
      ))}
    </SectionCard>
  );
}

function HistoryModal({ row, history, onClose }: { row: PlaybookRow; history: PlaybookRow[]; onClose: () => void }) {
  const prev = [...history].filter((h) => h.version < row.version).sort((a, b) => b.version - a.version)[0] ?? null;
  return (
    <Modal open onClose={onClose} size="xl" icon="logs" title={`Playbook v${row.version}`}
      subtitle={`${row.status.replace('_', ' ')} · by ${row.createdBy} · ${fmtDate(row.createdAt)}${row.decidedAt ? ` · decided ${fmtDate(row.decidedAt)}` : ''}`}>
      <div className="apb-col">
        {row.rationale && <p className="apb-prose">{row.rationale}</p>}
        {row.brief && <BriefBlock brief={row.brief} />}
        <div className="apb-split">
          {row.review && <Fact title="Reviewer"><ReviewBlock review={row.review} /></Fact>}
          <Fact title={prev ? `Changes vs v${prev.version}` : 'Changes'}>
            <DiffSummary groups={diffPlaybooks(prev?.body, row.body)} empty={prev ? `Same as v${prev.version}.` : 'First version.'} />
          </Fact>
        </div>
        <PlaybookView body={row.body} />
      </div>
      <div className="modal-foot"><button type="button" className="btn-ghost" onClick={onClose}>Close</button></div>
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
      <label className="text-eyebrow apb-label" htmlFor="pb-brief">Brief</label>
      <textarea id="pb-brief" className="input-field apb-textarea" value={brief} maxLength={4000} onChange={(e) => setBrief(e.target.value)}
        placeholder="E.g. more short videos on TikTok, fact carousels on Instagram, a weekly digest in Telegram every Sunday…" />
      <div className="text-micro apb-count apb-dim">
        <span>Leave empty to rebuild from the channel card's brief{hasActive ? ' and the current playbook' : ''}.</span>
        <span className="mono tabular-nums">{brief.length} / 4000</span>
      </div>
      {rebuild.error && <div className="callout-danger apb-gap-top">{errorText(rebuild.error)}</div>}
      <div className="modal-foot">
        <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={rebuild.isPending} onClick={start}>
          <Icon name="sparkles" size={14} /> {rebuild.isPending ? 'Starting…' : 'Start rebuild'}
        </button>
      </div>
    </Modal>
  );
}
