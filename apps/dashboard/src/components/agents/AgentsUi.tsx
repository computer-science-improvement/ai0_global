// Shared bits of the agent-registry pages (/app/agents*, spec 017): kind labels,
// the emoji glyph, scope chip, last-run badge, the mode switch (live behind a
// confirmation), the pause dialog and a small on/off switch.

import { useState, type CSSProperties } from 'react';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { Field } from '../ui/primitives';
import { Modal } from '../Modal';
import { SegmentedTabs } from '../SegmentedTabs';
import { useConfirm } from '../ui/ConfirmDialog';
import { describeError, toast } from '../ui/Toast';
import { MODE_LABEL, MODE_OPTIONS, MODE_TONE, RUN_TONE } from '../editor/EditorUi';
import { fmtDate, fmtRelative } from '../../lib/format';
import { usePatchAgent, type Agent, type AgentActivity, type AgentKind, type AgentMode, type AgentNode } from '../../api/agents';

export const KIND_LABEL: Record<AgentKind, string> = {
  manager: 'Manager', builder: 'Builder', orchestrator: 'Orchestrator', planner: 'Planner', ideator: 'Ideator',
  idea_reviewer: 'Idea reviewer', executor: 'Executor', reviewer: 'Reviewer',
};

/** Default role a new skill applies to, by agent kind (mirrors roleOfKind on the server). */
export const ROLE_OF_KIND: Record<AgentKind, string> = {
  manager: 'manager', builder: 'builder', orchestrator: 'orchestrator', ideator: 'orchestrator',
  idea_reviewer: 'idea_reviewer', planner: 'planner', executor: 'executor', reviewer: 'reviewer',
};

const KIND_ICON = {
  manager: 'agents', builder: 'wrench', orchestrator: 'agents', planner: 'calendar', ideator: 'sparkles',
  idea_reviewer: 'check', executor: 'rocket', reviewer: 'eye',
} as const;

/** The agent's emoji in a tinted hub glyph, or its kind icon when there is no emoji. */
export function AgentGlyph({ agent, size = 38 }: { agent: Pick<Agent, 'emoji' | 'kind'>; size?: number }) {
  return (
    <div className="hub-glyph" aria-hidden style={{ width: size, height: size, fontSize: Math.round(size * 0.5), flexShrink: 0 }}>
      {agent.emoji || <Icon name={KIND_ICON[agent.kind]} size={Math.round(size * 0.45)} />}
    </div>
  );
}

export function ScopeChip({ agent }: { agent: Pick<Agent, 'scope' | 'scopeId'> }) {
  const label = agent.scope === 'system' ? 'system' : agent.scopeId ? (agent.scope === 'network' ? `network:${agent.scopeId}` : agent.scopeId) : agent.scope;
  return <span className="chip" style={{ fontSize: 11, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={label}>{label}</span>;
}

/** Mode + paused badges. */
export function StateBadges({ agent }: { agent: Pick<Agent, 'mode' | 'pausedUntil'> & { paused: boolean } }) {
  return (
    <>
      <Badge tone={MODE_TONE[agent.mode]}>{MODE_LABEL[agent.mode]}</Badge>
      {agent.paused && (
        <Badge tone="danger" title={agent.pausedUntil ? `until ${fmtDate(agent.pausedUntil)}` : 'until resumed'}>
          paused{agent.pausedUntil ? ` · until ${fmtDate(agent.pausedUntil)}` : ''}
        </Badge>
      )}
    </>
  );
}

/** Last run status badge + relative time (absolute in the tooltip). */
export function LastRun({ activity }: { activity: AgentActivity | null }) {
  if (!activity?.lastRunAt) return <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>no runs yet</span>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title={fmtDate(activity.lastRunAt)}>
      {activity.lastStatus && <Badge tone={RUN_TONE[activity.lastStatus]}>{activity.lastStatus}</Badge>}
      <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>{fmtRelative(activity.lastRunAt)}</span>
    </span>
  );
}

/** off / shadow / approve / live. Going live may publish to real resources without approval, so it is confirmed. */
export function AgentModeSwitch({ agent }: { agent: Pick<Agent, 'handle' | 'mode' | 'scopeId' | 'kind'> }) {
  const confirm = useConfirm();
  const patch = usePatchAgent(agent.handle);
  const onChange = async (next: AgentMode) => {
    if (next === agent.mode || patch.isPending) return;
    if (next === 'live') {
      const ok = await confirm(`switch @${agent.handle} to LIVE`, {
        danger: true,
        confirmLabel: 'Go live',
        details: (
          <div className="callout-warning" style={{ flexDirection: 'column', gap: 6 }}>
            <strong>Агент публікуватиме сам, без вашого апруву{agent.scopeId ? ` у ${agent.scopeId}` : ''}.</strong>
            <span className="text-micro">Для оркестратора Telegram-ресурсу це перемикач публікацій картки каналу. Перевірте, що пости на апруві виходили без правок, витрати і що жодна стара стратегія не постить у той самий ресурс.</span>
          </div>
        ),
      });
      if (!ok) return;
    }
    patch.mutate({ mode: next }, {
      onSuccess: () => toast.success(`@${agent.handle} → ${next}`),
      onError: (e) => toast.error(describeError(e)),
    });
  };
  return <SegmentedTabs size="sm" value={agent.mode} onChange={onChange} options={MODE_OPTIONS} />;
}

type PauseChoice = 'indefinite' | '24h' | 'until';

function localInputValue(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Pause button (opens the pause dialog) or Resume, depending on state. */
export function PauseButton({ agent, compact = false }: { agent: Pick<Agent, 'handle' | 'status' | 'pausedUntil'> & { paused: boolean }; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const patch = usePatchAgent(agent.handle);
  const resume = () => patch.mutate({ status: 'active', paused_until: null }, {
    onSuccess: () => toast.success(`@${agent.handle} resumed`),
    onError: (e) => toast.error(describeError(e)),
  });
  const style: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6 };
  return (
    <>
      {agent.paused
        ? <button className="btn-secondary" style={style} disabled={patch.isPending} onClick={resume}><Icon name="play" size={14} />{!compact && ' Resume'}</button>
        : <button className="btn-secondary" style={style} onClick={() => setOpen(true)}><Icon name="pause" size={14} />{!compact && ' Pause'}</button>}
      {open && <PauseModal handle={agent.handle} onClose={() => setOpen(false)} />}
    </>
  );
}

function PauseModal({ handle, onClose }: { handle: string; onClose: () => void }) {
  const patch = usePatchAgent(handle);
  const [choice, setChoice] = useState<PauseChoice>('24h');
  const [until, setUntil] = useState(() => localInputValue(new Date(Date.now() + 3 * 86_400_000)));
  const min = localInputValue(new Date(Date.now() + 5 * 60_000));
  const max = localInputValue(new Date(Date.now() + 90 * 86_400_000));

  const submit = () => {
    const body = choice === 'indefinite' ? { status: 'paused' as const }
      : choice === '24h' ? { paused_until: new Date(Date.now() + 86_400_000).toISOString() }
      : { paused_until: new Date(until).toISOString() };
    patch.mutate(body, { onSuccess: () => { toast.success(`@${handle} paused`); onClose(); } });
  };

  const opt = (key: PauseChoice, label: string, note: string) => (
    <label className="card" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 14px', cursor: 'pointer', boxShadow: choice === key ? 'inset 0 0 0 1px var(--color-accent)' : undefined }}>
      <input type="radio" name="pause" checked={choice === key} onChange={() => setChoice(key)} style={{ marginTop: 3, accentColor: 'var(--color-accent)' }} />
      <span>
        <span className="text-body-sm" style={{ color: 'var(--color-ink)', fontWeight: 500, display: 'block' }}>{label}</span>
        <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>{note}</span>
      </span>
    </label>
  );

  return (
    <Modal open onClose={onClose} title={`Pause @${handle}`} subtitle="A paused agent skips its scheduled runs; “Run now” is refused." icon="pause">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
        {opt('indefinite', 'Until I resume it', 'Status becomes paused.')}
        {opt('24h', 'For 24 hours', 'Resumes automatically.')}
        {opt('until', 'Until a date', 'Up to 90 days ahead.')}
      </div>
      {choice === 'until' && (
        <Field label="Resume at" hint="your local time">
          <input type="datetime-local" className="input-field" style={{ width: '100%', boxSizing: 'border-box', colorScheme: 'dark' }} value={until} min={min} max={max} onChange={(e) => setUntil(e.target.value)} />
        </Field>
      )}
      {patch.error && <div className="callout-danger" style={{ marginBottom: 8 }}>{describeError(patch.error)}</div>}
      <div className="modal-foot">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={patch.isPending || (choice === 'until' && !until)} onClick={submit}>Pause</button>
      </div>
    </Modal>
  );
}

/** A compact on/off switch (role="switch"). */
export function Toggle({ checked, onChange, label, disabled, title }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 7, background: 'none', border: 0, padding: 0,
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, color: 'var(--color-ink-muted)', fontSize: 12,
      }}
    >
      <span style={{
        position: 'relative', width: 28, height: 16, borderRadius: 'var(--radius-pill)', flexShrink: 0,
        background: checked ? 'var(--color-accent)' : 'var(--color-surface-3)',
        boxShadow: 'inset 0 0 0 1px var(--color-hairline)', transition: 'background 0.15s ease',
      }}>
        <span style={{
          position: 'absolute', top: 2, left: checked ? 14 : 2, width: 12, height: 12, borderRadius: 'var(--radius-pill)',
          background: checked ? 'var(--color-on-accent)' : 'var(--color-ink-dim)', transition: 'left 0.15s ease',
        }} />
      </span>
      {label}
    </button>
  );
}

/** "1 run" / "3 runs". */
export const runsLabel = (n: number) => `${n} run${n === 1 ? '' : 's'}`;

/** id → node for every agent in the tree (for resolving inbox agentIds). */
export function indexTree(nodes: AgentNode[] | undefined): Map<string, AgentNode> {
  const m = new Map<string, AgentNode>();
  const walk = (ns: AgentNode[]) => { for (const n of ns) { m.set(n.id, n); walk(n.children); } };
  walk(nodes ?? []);
  return m;
}
