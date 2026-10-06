// A confirmation card from an agent in the chat (spec 018 FR-005): what the
// agent proposes (create an agent, change one, write a skill…) with the owner's
// [Apply] / [Discard]. Nothing changes until Apply; the server re-validates the
// card against the current state, so a stale card comes back `failed` with the
// reason. Decided cards show their final status.

import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { Badge } from '../ui/Badge';
import { Icon, type IconName } from '../ui/Icon';
import type { Tone } from '../ui/primitives';
import { describeError, toast } from '../ui/Toast';
import { fmtDate, fmtRelative } from '../../lib/format';
import { KPI_GOALS, useDecideAction, type KpiGoal } from '../../api/agents';
import type { PendingAction, PendingActionStatus } from '../../api/types';

const KIND_META: Record<string, { label: string; icon: IconName }> = {
  create_agent:         { label: 'Create agent',      icon: 'sparkles' },
  update_agent:         { label: 'Update agent',      icon: 'pencil' },
  set_brief:            { label: 'Set brief',         icon: 'logs' },
  set_resource_profile: { label: 'Resource profile',  icon: 'globe' },
  write_skill:          { label: 'Write skill',       icon: 'book' },
  attach_skill:         { label: 'Attach skill',      icon: 'plus' },
  detach_skill:         { label: 'Detach skill',      icon: 'ban' },
  edit_data_schema:     { label: 'Edit dataset description', icon: 'database' },
};

export const ACTION_TONE: Record<PendingActionStatus, Tone> = {
  pending: 'warning', applied: 'success', failed: 'danger', discarded: 'neutral', expired: 'neutral',
};

export const GOAL_LABEL: Record<KpiGoal, string> = {
  growth: 'growth', engagement: 'engagement', transitions: 'transitions', revenue: 'revenue',
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v) && v.every((x) => typeof x !== 'object')) return v.join(', ') || '—';
  const o = obj(v);
  if (Array.isArray(o.times)) return (o.times as unknown[]).join(', ') || '—';
  return JSON.stringify(v);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(84px, 120px) 1fr', gap: 10, alignItems: 'baseline' }}>
      <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{label}</span>
      <span className="text-body-sm" style={{ color: 'var(--color-ink)', minWidth: 0, overflowWrap: 'anywhere' }}>{children}</span>
    </div>
  );
}

/** Goals in priority order as numbered chips. */
export function GoalChips({ goals }: { goals: string[] }) {
  if (!goals.length) return <>—</>;
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {goals.map((g, i) => (
        <span key={g} className="chip" style={{ gap: 5 }}>
          <span className="tabular-nums" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>{i + 1}</span>
          {(KPI_GOALS as readonly string[]).includes(g) ? GOAL_LABEL[g as KpiGoal] : g}
        </span>
      ))}
    </span>
  );
}

function CreateAgentView({ p }: { p: Record<string, unknown> }) {
  const profile = obj(p.profile);
  const aud = obj(profile.audience);
  const who = [str(aud.who), str(aud.age), str(aud.region)].filter(Boolean).join(' · ');
  const handle = str(p.handle)?.replace(/^@/, '');
  return (
    <>
      <Row label="Agent">
        <span style={{ fontWeight: 500 }}>{str(p.emoji) ?? '📣'} {str(p.name) ?? '—'}</span>
        {handle && <span style={{ color: 'var(--color-ink-muted)' }}> · @{handle}</span>}
      </Row>
      <Row label="Resource"><code style={{ fontSize: 12 }}>{str(p.resource_ref) ?? (str(p.network_id) ? `network:${p.network_id}` : '—')}</code></Row>
      {str(profile.topic) && <Row label="Topic">{profile.topic as string}</Row>}
      {who && <Row label="Audience">{who}</Row>}
      {strs(profile.goals).length > 0 && <Row label="Goals"><GoalChips goals={strs(profile.goals)} /></Row>}
    </>
  );
}

function UpdateAgentView({ p }: { p: Record<string, unknown> }) {
  const patch = Object.entries(obj(p.patch));
  return (
    <>
      {str(p.handle) && <Row label="Agent">@{p.handle as string}</Row>}
      {patch.map(([k, v]) => {
        const text = show(v);
        return (
          <Row key={k} label={k.replace(/_/g, ' ')}>
            <span style={{ fontFamily: /^[[{]/.test(text) ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined }}>{text}</span>
          </Row>
        );
      })}
      {patch.length === 0 && <Row label="Patch">—</Row>}
    </>
  );
}

function WriteSkillView({ p }: { p: Record<string, unknown> }) {
  const body = str(p.body);
  return (
    <>
      <Row label="Skill">
        <code style={{ fontSize: 12 }}>{str(p.name) ?? '—'}</code>
        {str(p.handle) && <span style={{ color: 'var(--color-ink-muted)' }}> · @{p.handle as string}</span>}
        {p.inline === true && <> <Badge>always in context</Badge></>}
      </Row>
      {str(p.description) && <Row label="Description">{p.description as string}</Row>}
      {strs(p.applies_to).length > 0 && (
        <Row label="Applies to">
          <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>{strs(p.applies_to).map((r) => <span key={r} className="chip">{r}</span>)}</span>
        </Row>
      )}
      {body && (
        <details>
          <summary className="text-micro" style={{ cursor: 'pointer', color: 'var(--color-ink-muted)' }}>
            Body · {body.length.toLocaleString('en-US')} chars
          </summary>
          <pre className="text-micro" style={{
            margin: '6px 0 0', padding: 10, maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            background: 'var(--color-canvas)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-sm)',
            color: 'var(--color-ink-muted)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          }}>{body}</pre>
        </details>
      )}
    </>
  );
}

function PayloadView({ action }: { action: PendingAction }) {
  const p = obj(action.payload);
  if (action.kind === 'create_agent') return <CreateAgentView p={p} />;
  if (action.kind === 'update_agent') return <UpdateAgentView p={p} />;
  if (action.kind === 'write_skill') return <WriteSkillView p={p} />;
  return null;
}

export function ActionCard({ action }: { action: PendingAction }) {
  const decide = useDecideAction();
  // The decision's response until the chat refetch brings the same status.
  const [local, setLocal] = useState<PendingAction | null>(null);
  const a = action.status === 'pending' && local ? local : action;
  const meta = KIND_META[a.kind] ?? { label: a.kind.replace(/_/g, ' '), icon: 'wrench' as IconName };
  const pending = a.status === 'pending';
  const busy = decide.isPending;
  const payload = <PayloadView action={a} />;
  const createdHandle = a.kind === 'create_agent' && a.status === 'applied' ? str(obj(a.result).handle) : null;

  const run = (decision: 'apply' | 'discard') => decide.mutate({ id: a.id, decision }, {
    onSuccess: (r) => {
      setLocal(r.action);
      if (r.action.status === 'applied') toast.success(`Applied: ${meta.label.toLowerCase()}`);
      else if (r.action.status === 'failed') toast.error(`Not applied: ${r.action.error ?? 'failed'}`);
      else if (r.action.status === 'expired') toast.error('This card has expired — ask the agent again');
    },
  });

  return (
    <div className="card compose-rise" style={{ padding: 14, maxWidth: 560, boxShadow: pending ? 'inset 0 0 0 1px var(--color-hairline)' : undefined }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <span className="section-glyph" style={{ width: 26, height: 26 }}><Icon name={meta.icon} size={14} /></span>
        <span className="text-caption" style={{ color: 'var(--color-ink)', fontWeight: 600 }}>{meta.label}</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {!pending && a.decidedAt && (
            <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }} title={fmtDate(a.decidedAt)}>{fmtRelative(a.decidedAt)}</span>
          )}
          <Badge tone={ACTION_TONE[a.status] ?? 'neutral'}>{pending ? 'needs your confirmation' : a.status}</Badge>
        </span>
      </div>

      <p className="text-body-sm" style={{ margin: '0 0 10px', color: 'var(--color-ink)', lineHeight: 1.5, overflowWrap: 'anywhere' }}>{a.summary}</p>

      {(a.kind === 'create_agent' || a.kind === 'update_agent' || a.kind === 'write_skill') && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 6, padding: 12,
          background: 'var(--color-surface-1)', border: '1px solid var(--color-hairline-soft)', borderRadius: 'var(--radius-lg)',
        }}>
          {payload}
        </div>
      )}

      {a.status === 'failed' && a.error && (
        <div className="callout-danger" style={{ marginTop: 10 }}><span className="text-micro" style={{ overflowWrap: 'anywhere' }}>{a.error}</span></div>
      )}
      {decide.error && (
        <div className="callout-danger" style={{ marginTop: 10 }}><span className="text-micro">{describeError(decide.error)}</span></div>
      )}

      {pending && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <button className="btn-primary" disabled={busy} onClick={() => run('apply')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name="check" size={14} /> Apply
          </button>
          <button className="btn-secondary" disabled={busy} onClick={() => run('discard')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name="x" size={14} /> Discard
          </button>
          <span className="text-micro" style={{ color: 'var(--color-ink-dim)', alignSelf: 'center' }}>Nothing changes until you apply</span>
        </div>
      )}

      {createdHandle && (
        <div style={{ marginTop: 10 }}>
          <Link to="/app/agents/$handle" params={{ handle: createdHandle }} className="link-accent text-body-sm"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            Open @{createdHandle} <Icon name="chevron-right" size={14} />
          </Link>
          <span className="text-micro" style={{ color: 'var(--color-ink-dim)', marginLeft: 8 }}>starts in shadow mode</span>
        </div>
      )}
    </div>
  );
}
