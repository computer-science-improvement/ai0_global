// The artifact panel (spec 048 FR-005): one artifact's details, the owner's hand edit, its actions, its versions with a
// diff against the one before, and "Ask the agent". The chat shows it as a right column (a full-screen sheet on a
// phone); the artifacts page opens the same panel. Setup and steering reuse their own views and actions.

import { useState, type ReactNode } from 'react';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { Field } from '../ui/primitives';
import { Modal } from '../Modal';
import { useConfirm } from '../ui/ConfirmDialog';
import { describeError, toast } from '../ui/Toast';
import { errorBody } from '../../api/agents';
import {
  useArtifact, useArtifactAction, useArtifactVersion, usePatchArtifact,
  type ArtifactAction, type ArtifactDetail, type ArtifactType, type ArtifactVersionMeta,
} from '../../api/artifacts';
import { useSetupProposal } from '../../api/channel-setup';
import { useSteeringSet } from '../../api/steering';
import { ARTIFACT_META, artifactTone, statusLabel, versionText } from '../../lib/artifacts';
import { fmtRelative } from '../../lib/format';
import { ProposalBody } from '../setup/SetupProposalDialog';
import { SteeringActions, SteeringDetails } from '../steering/SteeringCard';
import { DiffView } from '../agents/AgentSkills';
import { LaunchBody } from '../launch/LaunchBody';

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/** The API refusal as one line: the type's reasons when there is a list. */
function refusal(e: unknown): string {
  const b = errorBody(e);
  if (Array.isArray(b?.details) && b!.details.length) return (b!.details as unknown[]).map(String).join(' · ');
  return typeof b?.details === 'string' ? `${b.error}: ${b.details}` : describeError(e);
}

export function ArtifactPanel({ type, id, onClose, onAsk, bare = false }: {
  type: ArtifactType; id: string; onClose: () => void; onAsk?: (type: ArtifactType, id: string) => void;
  /** Inside a dialog that has its own title: no header, no own scroll. */
  bare?: boolean;
}) {
  const q = useArtifact(type, id);
  const meta = ARTIFACT_META[type];
  const d = q.data;
  return (
    <div style={bare ? { display: 'grid' } : { display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      {!bare && <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '14px 16px 12px', borderBottom: '1px solid var(--color-hairline)' }}>
        <span className="btn-icon" aria-hidden style={{ width: 32, height: 32, flexShrink: 0, pointerEvents: 'none' }}><Icon name={meta.icon} size={16} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{meta.label}{d?.row.agent ? ` · @${d.row.agent}` : ''}</div>
          <h2 className="text-body-sm clamp" style={{ margin: 0, fontWeight: 600, color: 'var(--color-ink)', ['--clamp' as string]: 2 }}>{d?.row.title ?? '…'}</h2>
          {d && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
              <Badge tone={artifactTone(d.row.status)}>{statusLabel(d.row.status)}</Badge>
              {d.row.version != null && <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-muted)' }}>v{d.row.version}</span>}
              {d.row.live && <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>shapes posts now</span>}
            </div>
          )}
        </div>
        <button type="button" className="btn-icon" onClick={onClose} aria-label="Close the artifact" title="Close" style={{ width: 32, height: 32, flexShrink: 0 }}>
          <Icon name="x" size={15} />
        </button>
      </div>}

      <div style={bare ? { display: 'grid', gap: 18 } : { flex: 1, minHeight: 0, overflowY: 'auto', padding: 16, display: 'grid', gap: 18, alignContent: 'start' }}>
        {q.error && <div className="callout-danger">{describeError(q.error)}</div>}
        {!d && !q.error && <div className="panel" style={{ height: 140, opacity: 0.55 }} />}
        {d && (
          <>
            {onAsk && (
              <button type="button" className="btn-secondary" onClick={() => onAsk(type, id)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifySelf: 'start' }}>
                <Icon name="chat" size={14} /> Ask the agent about it
              </button>
            )}
            <ArtifactBody d={d} onClose={onClose} />
            <GenericActions d={d} />
            <Versions d={d} />
          </>
        )}
      </div>
    </div>
  );
}

function ArtifactBody({ d, onClose }: { d: ArtifactDetail; onClose: () => void }) {
  const { type, id } = d.row;
  if (type === 'setup') return <SetupBody id={id} onClose={onClose} />;
  if (type === 'steering') return <SteeringBody id={id} />;
  if (type === 'rules') return <RulesBody d={d} />;
  if (type === 'memory') return <MemoryBody d={d} />;
  if (type === 'skill') return <SkillBody d={d} />;
  if (type === 'launch') return <LaunchBody d={d} />;
  return <JsonBody d={d} />;
}

function SetupBody({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useSetupProposal(id);
  if (q.error) return <div className="callout-danger">{describeError(q.error)}</div>;
  if (!q.data) return <div className="panel" style={{ height: 120, opacity: 0.55 }} />;
  return <ProposalBody v={q.data} onClose={onClose} />;
}

function SteeringBody({ id }: { id: string }) {
  const q = useSteeringSet(id);
  return (
    <>
      <SteeringDetails id={id} />
      {q.data && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <SteeringActions s={q.data.set} onDone={() => undefined} />
        </div>
      )}
    </>
  );
}

// ── owner rules and memory ─────────────────────────────────────────────────

interface RuleLine { id: number; kind?: string; text: string; source?: string | null; by?: string; createdAt?: string }

function RulesBody({ d }: { d: ArtifactDetail }) {
  const rules = ((d.body as { rules?: RuleLine[] } | null)?.rules ?? []);
  const patch = usePatchArtifact();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<RuleLine | 'new' | null>(null);
  const send = (p: unknown, done?: string) => patch.mutate({ type: 'rules', id: d.row.id, patch: p }, {
    onSuccess: () => { if (done) toast.success(done); setEditing(null); },
    onError: (e) => toast.error(refusal(e)),
  });
  return (
    <Field label={`Your rules (${rules.length})`} hint="They apply to every run of the channel's agent and win over everything else.">
      <div style={{ display: 'grid', gap: 6 }}>
        {rules.map((r) => (
          <div key={r.id} className="panel" style={{ padding: '8px 10px', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="text-body-sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{r.kind === 'avoid' ? 'Avoid: ' : ''}{r.text}</div>
              <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>#{r.id}{r.createdAt ? ` · ${fmtRelative(r.createdAt)}` : ''}{r.source ? ` · ${r.source}` : ''}</div>
            </div>
            <button type="button" className="btn-act" title="Edit" aria-label="Edit the rule" onClick={() => setEditing(r)}><Icon name="pencil" size={13} /></button>
            <button type="button" className="btn-act btn-act-danger" title="Retire" aria-label="Retire the rule" disabled={patch.isPending}
              onClick={async () => { if (await confirm('retire this rule (it stays in the history)', { confirmLabel: 'Retire' })) send({ retire: [r.id] }, 'Rule retired'); }}>
              <Icon name="trash" size={13} />
            </button>
          </div>
        ))}
        <button type="button" className="btn-secondary" onClick={() => setEditing('new')} style={{ justifySelf: 'start', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Icon name="plus" size={13} /> Add a rule
        </button>
      </div>
      {editing && (
        <TextEditDialog title={editing === 'new' ? 'New rule' : `Edit rule #${editing.id}`} initial={editing === 'new' ? '' : editing.text}
          busy={patch.isPending} onClose={() => setEditing(null)}
          onSave={(text) => send(editing === 'new' ? { add: [text] } : { edit: [{ id: editing.id, text }] }, editing === 'new' ? 'Rule added' : 'Rule saved')} />
      )}
    </Field>
  );
}

function MemoryBody({ d }: { d: ArtifactDetail }) {
  const lines = ((d.body as { lines?: RuleLine[] } | null)?.lines ?? []);
  const patch = usePatchArtifact();
  const confirm = useConfirm();
  return (
    <Field label={`Learnt lines (${lines.length})`} hint="Written by the agents from reviews and your approvals. You can retire a line; the agents add new ones.">
      <div style={{ display: 'grid', gap: 6 }}>
        {lines.map((r) => (
          <div key={r.id} className="panel" style={{ padding: '8px 10px', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="text-body-sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{r.text}</div>
              <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{r.kind ?? 'note'}{r.by ? ` · ${r.by}` : ''}{r.createdAt ? ` · ${fmtRelative(r.createdAt)}` : ''}</div>
            </div>
            <button type="button" className="btn-act btn-act-danger" title="Retire" aria-label="Retire the line" disabled={patch.isPending}
              onClick={async () => {
                if (!(await confirm('retire this line from the memory', { confirmLabel: 'Retire' }))) return;
                patch.mutate({ type: 'memory', id: d.row.id, patch: { retire: [r.id] } }, { onSuccess: () => toast.success('Line retired'), onError: (e) => toast.error(refusal(e)) });
              }}>
              <Icon name="trash" size={13} />
            </button>
          </div>
        ))}
      </div>
    </Field>
  );
}

// ── skills, playbooks, profiles, formatting ─────────────────────────────────

function SkillBody({ d }: { d: ArtifactDetail }) {
  const b = (d.body ?? {}) as { description?: string; appliesTo?: string[]; body?: string; scope?: string };
  const editable = d.actions.some((a) => a.key === 'edit');
  const patch = usePatchArtifact();
  const [open, setOpen] = useState(false);
  return (
    <>
      {b.description && <Field label="When it applies"><div className="text-body-sm">{b.description}</div></Field>}
      {!!b.appliesTo?.length && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{b.appliesTo.map((r) => <span key={r} className="chip">{r}</span>)}</div>
      )}
      <Field label="Body">
        <Pre>{b.body ?? ''}</Pre>
      </Field>
      {editable && (
        <button type="button" className="btn-secondary" onClick={() => setOpen(true)} style={{ justifySelf: 'start', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Icon name="pencil" size={13} /> Edit the skill
        </button>
      )}
      {b.scope && b.scope !== 'agent' && <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>A shared skill: change it per agent on the agent's Skills tab.</div>}
      {open && (
        <TextEditDialog title={`Edit ${d.row.title}`} initial={b.body ?? ''} rows={16} mono busy={patch.isPending} onClose={() => setOpen(false)}
          onSave={(body) => patch.mutate({ type: 'skill', id: d.row.id, patch: { body } }, {
            onSuccess: () => { toast.success('Skill saved as a new version'); setOpen(false); },
            onError: (e) => toast.error(refusal(e)),
          })} />
      )}
    </>
  );
}

function JsonBody({ d }: { d: ArtifactDetail }) {
  const editable = d.actions.some((a) => a.key === 'edit');
  const patch = usePatchArtifact();
  const [open, setOpen] = useState(false);
  const isPlaybook = d.row.type === 'playbook';
  const pb = isPlaybook ? (d.body as { active?: { body: unknown; rationale?: string | null } | null; pending?: { body: unknown; rationale?: string | null } | null }) : null;
  const shown = isPlaybook ? pb?.active?.body ?? null : d.body;
  return (
    <>
      {pb?.pending && (
        <div className="callout-warning"><Icon name="clock" size={16} /><div>A new version waits for your approval{pb.pending.rationale ? `: ${pb.pending.rationale}` : '.'}</div></div>
      )}
      {d.row.summary && <div className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>{d.row.summary}</div>}
      <Field label={isPlaybook ? 'Active version' : 'Fields'}>
        <Pre>{shown == null ? 'No active version yet.' : JSON.stringify(shown, null, 2)}</Pre>
      </Field>
      {editable && (
        <button type="button" className="btn-secondary" onClick={() => setOpen(true)} style={{ justifySelf: 'start', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Icon name="pencil" size={13} /> Edit
        </button>
      )}
      {open && (
        <TextEditDialog title={`Edit ${d.row.title}`} rows={18} mono busy={patch.isPending} onClose={() => setOpen(false)}
          hint={isPlaybook ? 'The playbook body as JSON. It becomes the active version.' : 'The fields to change, as JSON; the other fields stay.'}
          initial={JSON.stringify(shown ?? {}, null, 2)}
          onSave={(text) => {
            let parsed: unknown;
            try { parsed = JSON.parse(text); } catch { toast.error('That is not valid JSON.'); return; }
            patch.mutate({ type: d.row.type, id: d.row.id, patch: isPlaybook ? { body: parsed, rationale: 'Edited by the owner' } : parsed }, {
              onSuccess: () => { toast.success('Saved'); setOpen(false); },
              onError: (e) => toast.error(refusal(e)),
            });
          }} />
      )}
    </>
  );
}

/** Actions that change what gets published ask first (spec 052: Start and Go live). */
const CONFIRM: Record<string, string> = {
  'launch:start': 'apply the plan and put the channel into approval mode (posts wait for you)',
  'launch:go_live': 'let the channel publish without your approval (clean waiting posts are approved too)',
};

/** The type's own actions the reused views do not show already (approve a playbook version…). */
function GenericActions({ d }: { d: ArtifactDetail }) {
  const act = useArtifactAction();
  const confirm = useConfirm();
  if (d.row.type === 'setup' || d.row.type === 'steering') return null;
  const actions = d.actions.filter((a) => a.key !== 'edit' && a.path);
  if (!actions.length) return null;
  const run = async (a: ArtifactAction) => {
    const ask = a.danger ? `${a.label.toLowerCase()} — ${d.row.title}` : CONFIRM[`${d.row.type}:${a.key}`];
    if (ask && !(await confirm(ask, { confirmLabel: a.label }))) return;
    act.mutate(a, { onSuccess: () => toast.success(`${a.label}: done`), onError: (e) => toast.error(refusal(e)) });
  };
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {actions.map((a) => (
        <button key={a.key} type="button" className={a.danger ? 'btn-ghost' : 'btn-primary'} disabled={act.isPending} onClick={() => run(a)}
          style={a.danger ? { color: 'var(--color-danger)' } : undefined}>{a.label}</button>
      ))}
    </div>
  );
}

// ── versions ────────────────────────────────────────────────────────────────

function Versions({ d }: { d: ArtifactDetail }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!d.versions.length) return null;
  return (
    <Field label={`Versions (${d.versions.length})`} hint="Each version against the one before it.">
      <div style={{ display: 'grid', gap: 4 }}>
        {d.versions.map((v) => (
          <div key={v.version}>
            <button type="button" className="row-lift" onClick={() => setOpen(open === v.version ? null : v.version)} aria-expanded={open === v.version}
              style={{ width: '100%', display: 'flex', gap: 8, alignItems: 'baseline', textAlign: 'left', background: open === v.version ? 'var(--color-surface-3)' : 'transparent', border: 'none', borderRadius: 'var(--radius-sm)', padding: '6px 8px', cursor: 'pointer', color: 'var(--color-ink)' }}>
              <span className="text-body-sm tabular-nums" style={{ fontWeight: 600 }}>v{v.version}</span>
              <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>{authorLabel(v)}</span>
              <span className="text-micro clamp" style={{ color: 'var(--color-ink-dim)', flex: 1, minWidth: 0, ['--clamp' as string]: 1 }}>{v.reason ?? ''}</span>
              <span className="text-micro" style={{ color: 'var(--color-ink-dim)', flexShrink: 0 }}>{fmtRelative(v.createdAt)}</span>
            </button>
            {open === v.version && <VersionDiff type={d.row.type} id={d.row.id} v={v.version} prev={prevOf(d.versions, v.version)} />}
          </div>
        ))}
      </div>
    </Field>
  );
}

const authorLabel = (v: ArtifactVersionMeta) => (v.author === 'system' ? 'recorded' : v.author === 'owner' ? 'you' : v.author);
const prevOf = (vs: ArtifactVersionMeta[], v: number) => vs.filter((x) => x.version < v).reduce<number | null>((m, x) => (m == null || x.version > m ? x.version : m), null);

function VersionDiff({ type, id, v, prev }: { type: ArtifactType; id: string; v: number; prev: number | null }) {
  const cur = useArtifactVersion(type, id, v);
  const before = useArtifactVersion(type, id, prev);
  if (cur.error) return <div className="callout-danger" style={{ marginTop: 4 }}>{describeError(cur.error)}</div>;
  if (!cur.data || (prev != null && !before.data)) return <div className="panel" style={{ height: 60, opacity: 0.55, marginTop: 4 }} />;
  const to = versionText(type, cur.data.body);
  return (
    <div style={{ padding: '6px 8px 10px' }}>
      {prev == null ? <Pre>{to}</Pre> : <DiffView from={versionText(type, before.data!.body)} to={to} />}
    </div>
  );
}

// ── small parts ─────────────────────────────────────────────────────────────

function Pre({ children }: { children: ReactNode }) {
  return (
    <pre style={{
      margin: 0, padding: 10, maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      fontFamily: mono, fontSize: 11.5, lineHeight: 1.5,
      background: 'var(--color-canvas)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--color-ink-muted)',
    }}>{children}</pre>
  );
}

function TextEditDialog({ title, initial, onSave, onClose, busy, rows = 4, mono: isMono = false, hint }: {
  title: string; initial: string; onSave: (text: string) => void; onClose: () => void; busy: boolean; rows?: number; mono?: boolean; hint?: string;
}) {
  const [text, setText] = useState(initial);
  return (
    <Modal open onClose={onClose} title={title} icon="pencil" size={rows > 8 ? 'lg' : 'md'}>
      <div style={{ display: 'grid', gap: 8 }}>
        {hint && <div className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>{hint}</div>}
        <textarea className="input-field" value={text} rows={rows} onChange={(e) => setText(e.target.value)} autoFocus aria-label={title}
          style={{ width: '100%', resize: 'vertical', ...(isMono ? { fontFamily: mono, fontSize: 12 } : {}) }} />
        <div className="modal-foot">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" disabled={busy || !text.trim() || text === initial} onClick={() => onSave(text.trim())}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
