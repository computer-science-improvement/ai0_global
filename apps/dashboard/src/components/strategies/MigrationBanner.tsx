// Spec 023 FR-011–FR-013, phase B: strategies no longer run (the scheduler is gone). Shown on /app/agents only
// while a channel still has enabled legacy bindings or a pending migration card: Migrate (dry run → draft for
// approval) turns the bindings into the agent's series, Cutover retires them and moves the agent to approval mode.
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { Modal } from '../Modal';
import { SectionCard } from '../ui/primitives';
import { useConfirm } from '../ui/ConfirmDialog';
import { errorBody, useDecideAction } from '../../api/agents';
import {
  useMigrationProposal, useProposeMigration, useStrategyMigration,
  type BindingOutcome, type MigrationChannel, type MigrationOp, type MigrationState,
} from '../../api/strategies';

const STATE: Record<MigrationState, { label: string; tone: 'success' | 'warning' | 'danger' | 'accent' | 'neutral'; help: string }> = {
  no_agent:      { label: 'No agent', tone: 'danger', help: 'No agent runs this channel yet. Create one on the Agents page (or ask @ai0), then migrate.' },
  not_migrated:  { label: 'Not migrated', tone: 'warning', help: 'The bindings are enabled but no longer publish. Migrate them into the agent\'s series, or pause them.' },
  draft_pending: { label: 'Draft awaits approval', tone: 'accent', help: 'Approve the migration playbook on the agent page.' },
  shadow:        { label: 'Agent in shadow', tone: 'accent', help: 'The agent writes the migrated series as previews. The cutover is offered after 7 days with 80% of the series done.' },
  cutover_ready: { label: 'Ready for cutover', tone: 'success', help: 'The migrated series ran a week in shadow. The cutover retires the bindings and moves the agent to approval mode.' },
  retired:       { label: 'Retired', tone: 'neutral', help: 'The agent publishes this channel; its strategy bindings are retired.' },
  legacy:        { label: 'Nothing enabled', tone: 'neutral', help: 'No enabled strategy binding on this channel.' },
};

const OP_LABEL: Record<MigrationOp, string> = { migrate: 'Migrate', cutover: 'Cutover', rollback: 'Rollback' };

/** Phase B: only channels that still need the owner — enabled bindings or a pending card. */
export function needsAttention(c: MigrationChannel): boolean {
  return c.enabled.length > 0 || c.cards.length > 0;
}
const KIND_OP: Record<string, MigrationOp> = { migrate_strategies: 'migrate', strategy_cutover: 'cutover', strategy_rollback: 'rollback' };

function errText(err: unknown): string {
  const b = errorBody(err);
  if (b) return `${b.error ?? 'error'}${b.details ? `: ${Array.isArray(b.details) ? b.details.join('; ') : String(b.details)}` : ''}`;
  return err instanceof Error ? err.message : String(err);
}

export function MigrationBanner() {
  const { data, isLoading, error } = useStrategyMigration();
  const [migrating, setMigrating] = useState<string | null>(null);
  const channels = (data?.channels ?? []).filter(needsAttention);
  if (!error && (isLoading || channels.length === 0)) return null;

  return (
    <SectionCard title="Legacy strategy bindings" flush delay={40} action={<Badge tone="warning">{channels.length}</Badge>}>
      <p className="mig-intro">
        Strategies were removed: these bindings are still enabled but publish nothing, the channel&apos;s agent writes its
        content. Migrate a channel to turn its bindings into the agent&apos;s series, then cut over to retire them.
      </p>
      {error && <div className="callout-danger mig-callout">{errText(error)}</div>}
      {channels.map((c) => <ChannelRow key={c.channel_key} c={c} onMigrate={() => setMigrating(c.channel_key)} />)}
      <MigrateModal channel={migrating} onClose={() => setMigrating(null)} />
    </SectionCard>
  );
}

function ChannelRow({ c, onMigrate }: { c: MigrationChannel; onMigrate: () => void }) {
  const s = STATE[c.state];
  const propose = useProposeMigration();
  const decide = useDecideAction();
  const confirm = useConfirm();
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const busy = propose.isPending || decide.isPending;

  const apply = async (id: string) => {
    const r = await decide.mutateAsync({ id, decision: 'apply' });
    if (r.action.status === 'applied') setMsg({ tone: 'ok', text: 'Applied.' });
    else setMsg({ tone: 'error', text: r.action.error ?? `Card ${r.action.status}.` });
  };
  const cutover = async () => {
    const text = `retire the migrated strategy bindings of ${c.channel_key} and switch @${c.agent?.handle} to approval mode`;
    if (!(await confirm(text, { confirmLabel: OP_LABEL.cutover }))) return;
    setMsg(null);
    try {
      const r = await propose.mutateAsync({ op: 'cutover', channel: c.channel_key });
      await apply(r.action.id);
    } catch (err) {
      setMsg({ tone: 'error', text: errText(err) });
    }
  };
  const canMigrate = c.agent && c.state === 'not_migrated';
  const canCutover = c.state === 'cutover_ready' && !c.cards.some((x) => x.kind === 'strategy_cutover');

  return (
    <div className="panel-row mig-row">
      <div className="mig-main">
        <div className="mig-title">
          <span className="mig-name">{c.channel_key}</span>
          <span title={s.help}><Badge tone={s.tone}>{s.label}</Badge></span>
          {c.agent && (
            <Link to="/app/agents/$handle" params={{ handle: c.agent.handle }} search={{ tab: 'schedule' }} className="link-accent mig-agent mono">
              @{c.agent.handle}
            </Link>
          )}
        </div>
        <div className="mig-meta">
          <span>{c.enabled.length} enabled</span>
          {c.retired.length > 0 && <span>· {c.retired.length} retired</span>}
          {c.agent && <span>· agent mode {c.agent.mode}</span>}
          {c.shadow && c.shadow.since && (
            <span title="Migrated series instances realised in the last 7 days">
              · {c.shadow.days} day(s) in shadow, {Math.round(c.shadow.ratio * 100)}% of {c.shadow.expected} instances
            </span>
          )}
          {c.draft && <span>· draft v{c.draft.version}</span>}
        </div>
        {msg && <div className={`mig-msg ${msg.tone === 'ok' ? 'is-ok' : 'is-error'}`} role="status">{msg.text}</div>}
        {c.cards.map((card) => (
          <div key={card.id} className="mig-card">
            <Badge tone="accent">{OP_LABEL[KIND_OP[card.kind] ?? 'migrate']} card</Badge>
            <span className="mig-card-text">{card.summary}</span>
            <button className="btn-tiny" disabled={busy} onClick={() => { setMsg(null); apply(card.id).catch((err) => setMsg({ tone: 'error', text: errText(err) })); }}>
              <Icon name="check" size={12} /> Apply
            </button>
            <button className="btn-tiny" disabled={busy} onClick={() => decide.mutate({ id: card.id, decision: 'discard' })}>
              <Icon name="x" size={12} /> Discard
            </button>
          </div>
        ))}
      </div>
      <div className="mig-actions">
        {canMigrate && (
          <button className="btn-warning btn-sm" disabled={busy} onClick={onMigrate}>
            <Icon name="agents" size={14} /> Migrate
          </button>
        )}
        {canCutover && (
          <button className="btn-warning btn-sm" disabled={busy} onClick={cutover}>
            <Icon name="check" size={14} /> Cutover
          </button>
        )}
      </div>
    </div>
  );
}

const OUTCOME: Record<BindingOutcome['outcome'], { label: string; tone: 'success' | 'accent' | 'warning' }> = {
  series:     { label: 'series', tone: 'success' },
  frequency:  { label: 'frequency', tone: 'accent' },
  unmappable: { label: 'unmappable', tone: 'warning' },
};

function outcomeText(b: BindingOutcome): string {
  if (b.outcome === 'series') return `${b.cadence} · ${b.format}${b.source ? ` · ${b.source}${b.source_mode === 'required' ? ' (required)' : ''}` : ' · no source'}`;
  if (b.outcome === 'frequency') return `about ${b.per_day}/day · ${b.format}${b.source ? ` · ${b.source}` : ''} — ${b.reason}`;
  return b.reason;
}

/** The dry run of one channel, then the migrate card (applied here: the draft waits for approval on the agent page). */
function MigrateModal({ channel, onClose }: { channel: string | null; onClose: () => void }) {
  const { data: p, isLoading, error } = useMigrationProposal(channel);
  const propose = useProposeMigration();
  const decide = useDecideAction();
  const [result, setResult] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const close = () => { setResult(null); propose.reset(); onClose(); };
  const busy = propose.isPending || decide.isPending;
  const blocked = !p || !p.mapped || p.errors.length > 0;

  const submit = async () => {
    if (!channel) return;
    setResult(null);
    try {
      const r = await propose.mutateAsync({ op: 'migrate', channel });
      const d = await decide.mutateAsync({ id: r.action.id, decision: 'apply' });
      if (d.action.status === 'applied') {
        const v = (d.action.result as { version?: number } | null)?.version;
        setResult({ tone: 'ok', text: `Migration draft${v ? ` v${v}` : ''} created. Approve it on the agent page, then cut over to retire the bindings.` });
      } else {
        setResult({ tone: 'error', text: d.action.error ?? `Card ${d.action.status}.` });
      }
    } catch (err) {
      setResult({ tone: 'error', text: errText(err) });
    }
  };

  return (
    <Modal open={!!channel} onClose={close} title={`Migrate ${channel ?? ''}`} subtitle="How each enabled strategy binding maps to the agent (nothing is written yet)" icon="agents" size="lg">
      {isLoading && <p className="mig-note">Building the proposal…</p>}
      {error && <div className="callout-danger" style={{ overflowWrap: 'anywhere' }}>{errText(error)}</div>}
      {p && (
        <div>
          <p className="mig-lead">
            {p.mapped} of {p.total} enabled strategy bindings map to <span className="mono">@{p.agent?.handle}</span>
            {p.active_version ? ` (on top of playbook v${p.active_version})` : ' (a new playbook from the channel card)'}.
          </p>
          <div className="mig-list">
            {p.bindings.map((b) => (
              <div key={b.ext_id} className="mig-binding">
                <div className="mig-binding-head">
                  <span className="mig-binding-name">{b.ext_id}</span>
                  <Badge tone={OUTCOME[b.outcome].tone}>{OUTCOME[b.outcome].label}</Badge>
                  <span className="mig-binding-sched mono">{b.schedule}</span>
                </div>
                <div className="mig-binding-text">{outcomeText(b)}</div>
                {b.warnings.map((w, i) => (
                  <div key={i} className="mig-binding-warn">! {w}</div>
                ))}
              </div>
            ))}
          </div>
          {p.errors.length > 0 && (
            <div className="callout-danger" style={{ marginTop: 12, overflowWrap: 'anywhere' }}>The draft does not validate: {p.errors.join('; ')}</div>
          )}
        </div>
      )}
      {result && (
        <div className={result.tone === 'ok' ? 'callout-success' : 'callout-danger'} role="status" style={{ marginTop: 12, overflowWrap: 'anywhere' }}>{result.text}</div>
      )}
      <div className="modal-foot">
        <button className="btn-ghost" onClick={close}>{result?.tone === 'ok' ? 'Close' : 'Cancel'}</button>
        {result?.tone !== 'ok' && (
          <button className="btn-primary" disabled={busy || blocked} onClick={submit}>
            {busy ? 'Creating…' : 'Create migration draft'}
          </button>
        )}
      </div>
    </Modal>
  );
}
