// Skills tab of /app/agents/$handle (spec 017 FR-011): grouped skill list with
// toggles, the skill editor (lint errors inline, safety confirm), versions with
// a line diff and rollback, reset/delete and lock.
// Spec 078 D2: a skill is a row of a flush panel; the editor and the versions are dialogs; classes of agent-playbook.css (apb-).

import { Link } from '@tanstack/react-router';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { SectionCard, EmptyState, Field } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { TableAction, RowActions } from '../ui/table';
import { Modal } from '../Modal';
import { useConfirm } from '../ui/ConfirmDialog';
import { describeError, toast } from '../ui/Toast';
import { fmtDate, fmtRelative } from '../../lib/format';
import { ROLE_OF_KIND, Toggle } from './AgentsUi';
import { SkillProbeDialog } from './SkillProbeDialog';
import { canAdoptAnyway, hasProbeDetails, probeBadge, probeSummary } from '../../lib/skill-probe';
import {
  errorBody, SKILL_MAX_BODY, SKILL_MAX_INLINE_BODY, SKILL_ROLES, useAgentSkills, useDeleteSkill, usePatchSkill, usePutSkill,
  useRollbackSkill, useSkillVersions, type AgentDetail, type AgentSkillEntry, type SkillLintIssue, type SkillOrigin, type SkillVersion,
} from '../../api/agents';

const ORIGIN_TONE: Record<SkillOrigin, 'accent' | 'neutral' | 'success'> = {
  own: 'accent', override: 'accent', builtin: 'neutral', global: 'neutral', inherited: 'neutral',
};
const OUTCOME_TONE = { pending: 'warning', kept: 'success', rolled_back: 'danger', superseded: 'neutral', probing: 'warning', rejected: 'danger' } as const;
const AUTHOR_TONE = { repo: 'neutral', owner: 'success', agent: 'warning' } as const;

type EditTarget = { entry: AgentSkillEntry | null };

export function AgentSkills({ data }: { data: AgentDetail }) {
  const handle = data.agent.handle;
  const skills = useAgentSkills(handle);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [versionsOf, setVersionsOf] = useState<AgentSkillEntry | null>(null);

  const list = skills.data?.skills ?? [];
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? list.filter((e) => e.skill.name.includes(s) || e.skill.description.toLowerCase().includes(s)) : list;
  }, [list, q]);
  const groups: Array<{ title: string; icon: 'pencil' | 'book' | 'agents'; items: AgentSkillEntry[]; note: string }> = [
    { title: 'Own & overridden', icon: 'pencil', items: filtered.filter((e) => e.origin === 'own' || e.origin === 'override'), note: 'Skills written for this agent, and overrides of built-ins.' },
    { title: 'Built-in & global', icon: 'book', items: filtered.filter((e) => e.origin === 'builtin' || e.origin === 'global'), note: 'Shared skills from the repository. Editing one creates an override.' },
    { title: 'Inherited', icon: 'agents', items: filtered.filter((e) => e.origin === 'inherited'), note: `From ${data.parent ? `@${data.parent.handle}` : 'the orchestrator'}.` },
  ];

  if (skills.error) return <div className="callout-danger">{describeError(skills.error)}</div>;
  if (!skills.data) return <div className="apb-skeleton" style={{ height: 120 }} aria-hidden />;

  return (
    <div className="apb-stack">
      <div className="apb-toolbar">
        <input className="input-field apb-search" placeholder="Filter skills…" aria-label="Filter skills" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="text-micro mono apb-dim">{list.filter((e) => e.enabled).length} of {list.length} enabled</span>
        <button type="button" className="btn-primary btn-sm" onClick={() => setEditing({ entry: null })}>
          <Icon name="plus" size={14} /> New skill
        </button>
      </div>

      {groups.map((g, gi) => (g.items.length > 0 || (gi === 0 && !q)) && (
        <SectionCard key={g.title} title={`${g.title} · ${g.items.length}`} icon={g.icon} flush delay={gi * 40}>
          <p className="apb-group-note">{g.note}</p>
          {g.items.length === 0
            ? <EmptyState icon="pencil" title="No own skills yet" note="Write a skill for this agent, or edit a built-in to override it." />
            : g.items.map((e) => (
              <SkillRow key={e.skill.id} entry={e} data={data}
                onEdit={() => setEditing({ entry: e })} onVersions={() => setVersionsOf(e)} />
            ))}
        </SectionCard>
      ))}
      {q && filtered.length === 0 && <EmptyState icon="discovery" title="No skills match" />}

      {editing && <SkillEditorModal data={data} entry={editing.entry} existing={list} onClose={() => setEditing(null)} />}
      {versionsOf && <VersionsModal entry={versionsOf} onClose={() => setVersionsOf(null)} />}
    </div>
  );
}

/** One skill as a row of its group's flush panel: name and badges, the description, a meta line; the switches and actions on the right. */
function SkillRow({ entry: e, data, onEdit, onVersions }: {
  entry: AgentSkillEntry; data: AgentDetail; onEdit: () => void; onVersions: () => void;
}) {
  const handle = data.agent.handle;
  const s = e.skill;
  const confirm = useConfirm();
  const toggle = usePatchSkill(handle);
  const del = useDeleteSkill(handle);
  const busy = toggle.isPending || del.isPending;
  const agentScoped = s.scope === 'agent' && e.origin !== 'inherited';

  const remove = async () => {
    const reset = e.origin === 'override';
    const ok = await confirm(reset ? `reset “${s.name}” to the built-in default` : `delete the skill “${s.name}”`, {
      confirmLabel: reset ? 'Reset' : 'Delete',
      details: reset ? <p className="text-micro apb-note">The override and its versions are removed; the agent goes back to the built-in text.</p> : undefined,
    });
    if (ok) del.mutate(s.name, { onSuccess: () => toast.success(reset ? `${s.name} reset to default` : `${s.name} deleted`) });
  };

  return (
    <div className={`panel-row apb-skill${e.enabled ? '' : ' is-off'}`}>
      <div className="apb-skill-main">
        <div className="apb-skill-title">
          <span className="apb-skill-name mono">{s.name}</span>
          <Badge tone={ORIGIN_TONE[e.origin]}>{e.origin}</Badge>
          {s.safety && <Badge tone="danger" title="System safety skill — agents can never change it">safety</Badge>}
          {s.locked && <Badge tone="neutral" title="Locked by the owner — agents cannot edit it"><Icon name="lock" size={10} /> locked</Badge>}
          {e.pending && <Badge tone="warning" title="An agent-written version is waiting for its 7-day KPI review">pending review</Badge>}
          {e.probing && <Badge tone="warning" title="A newer edit of this skill is being tried on recent posts; the text below stays live until the probe decides">probing</Badge>}
          {e.baseChanged && <Badge tone="warning" title="The built-in this override is based on changed in the repository">base changed</Badge>}
        </div>
        <div className="clamp apb-skill-desc" title={s.description}>{s.description}</div>
        <div className="text-micro apb-skill-meta">
          <span className="mono tabular-nums">v{s.currentVersion}{s.baseVersion != null ? ` · base v${s.baseVersion}` : ''}</span>
          <span aria-hidden>·</span>
          <span title={fmtDate(s.updatedAt)}>{s.createdBy} · <span className="mono">{fmtRelative(s.updatedAt)}</span></span>
          <span aria-hidden>·</span>
          <span className="mono tabular-nums">{s.body.length.toLocaleString()} chars</span>
          {s.appliesTo.map((r) => <span key={r} className="chip mono">{r}</span>)}
        </div>
      </div>
      <div className="apb-skill-side">
        <div className="apb-skill-toggles">
          <Toggle label="Enabled" checked={e.enabled} disabled={busy} onChange={(v) => toggle.mutate({ name: s.name, enabled: v })} />
          <Toggle label="Always in context" checked={e.inline} disabled={busy || !e.enabled}
            title={s.body.length > SKILL_MAX_INLINE_BODY ? `Over ${SKILL_MAX_INLINE_BODY} chars — would stay on demand` : 'Always in context (otherwise loaded on demand)'}
            onChange={(v) => toggle.mutate({ name: s.name, inline: v })} />
        </div>
        <RowActions danger={
          e.origin === 'override' ? <TableAction icon="refresh" danger title="Reset to default" disabled={busy} onClick={remove} />
          : e.origin === 'own' ? <TableAction action="delete" disabled={busy} onClick={remove} />
          : undefined
        }>
          {e.origin === 'inherited'
            ? data.parent && (
              <Link to="/app/agents/$handle" params={{ handle: data.parent.handle }} search={{ tab: 'skills' }} className="btn-act" title={`Edit in @${data.parent.handle}`} aria-label={`Edit in @${data.parent.handle}`}>
                <Icon name="pencil" size={14} />
              </Link>
            )
            : <TableAction action="edit" title={e.origin === 'builtin' || e.origin === 'global' ? 'Edit (creates an override)' : 'Edit'} onClick={onEdit} />}
          <TableAction icon="history" title="Versions" onClick={onVersions} />
          {agentScoped && (
            <TableAction icon={s.locked ? 'unlock' : 'lock'} title={s.locked ? 'Unlock (agents may edit it again)' : 'Lock (agents may not edit it)'} disabled={busy}
              onClick={() => toggle.mutate({ name: s.name, locked: !s.locked })} />
          )}
        </RowActions>
      </div>
      {e.baseChanged && (
        <div className="callout-warning apb-skill-alert">
          <Icon name="warning" size={14} />
          <span className="text-micro">The built-in <code>{s.name}</code> changed in the repository since this override was written (base v{s.baseVersion ?? '?'}). Review the override, or reset to default to take the new text.</span>
        </div>
      )}
    </div>
  );
}

// ── editor ──────────────────────────────────────────────────────────────────

const NAME_RE = /^[a-z0-9-]{3,48}$/;
/** Lint codes the owner cannot force past (mirrors skill-store.writeAgentSkill). */
const UNFORCEABLE = new Set(['name', 'description', 'applies_to', 'body_empty', 'body_too_long']);

function SkillEditorModal({ data, entry, existing, onClose }: {
  data: AgentDetail; entry: AgentSkillEntry | null; existing: AgentSkillEntry[]; onClose: () => void;
}) {
  const handle = data.agent.handle;
  const isNew = !entry;
  const shared = entry && (entry.origin === 'builtin' || entry.origin === 'global');
  const put = usePutSkill(handle);
  const confirm = useConfirm();
  const [name, setName] = useState(entry?.skill.name ?? '');
  const [description, setDescription] = useState(entry?.skill.description ?? '');
  const [appliesTo, setAppliesTo] = useState<string[]>(entry?.skill.appliesTo ?? [ROLE_OF_KIND[data.agent.kind]]);
  const [body, setBody] = useState(entry?.skill.body ?? '');
  const [lintErrors, setLintErrors] = useState<SkillLintIssue[] | null>(null);
  const [preview, setPreview] = useState(true);

  const clash = isNew ? existing.find((e) => e.skill.name === name.trim()) : undefined;
  const errors: string[] = [];
  if (isNew && !NAME_RE.test(name.trim())) errors.push('name');
  if (description.trim().length < 10 || description.trim().length > 300) errors.push('description');
  if (appliesTo.length === 0) errors.push('applies_to');
  if (!body.trim() || body.length > SKILL_MAX_BODY) errors.push('body');
  const forceable = !!lintErrors?.length && lintErrors.every((e) => !e.hard && !UNFORCEABLE.has(e.code));
  const inline = entry?.inline ?? false;

  const subtitle = isNew
    ? `A new skill for @${handle}. A name that matches a built-in creates an override of it.`
    : shared
      ? `Editing a ${entry!.origin === 'builtin' ? 'built-in' : 'global'} skill creates an override for @${handle} — the shared text stays unchanged; “Reset to default” removes the override.`
      : `Saving creates a new version${entry!.pending ? ' and supersedes the agent version waiting for review' : ''}${entry!.probing ? ' and drops the agent edit being probed' : ''}. Owner versions are never overwritten by agents.`;

  const save = async (force = false) => {
    if (errors.length) return;
    const skillName = (isNew ? name : entry!.skill.name).trim();
    try {
      const r = await put.mutateAsync({ name: skillName, description: description.trim(), applies_to: appliesTo, body, ...(force ? { force: true } : {}) });
      const warn = r.lint?.warnings?.length ? ` — ${r.lint.warnings.map((w) => w.message).join('; ')}` : '';
      toast.success(`${skillName} saved as v${r.version}${warn}`);
      onClose();
    } catch (err) {
      const b = errorBody(err);
      if (b?.error === 'skill_lint_failed' && Array.isArray(b.details)) { setLintErrors(b.details as SkillLintIssue[]); return; }
      if (b?.error === 'safety_skill') {
        const ok = await confirm(`change the safety skill “${skillName}”`, {
          confirmLabel: 'Save anyway',
          details: (
            <div className="callout-warning apb-callout-col">
              <strong>This is a system safety skill.</strong>
              <span className="text-micro">It keeps the agents inside the publishing guards. Agents can never change it; an owner override applies to @{handle} only. Make sure the new text keeps every safety rule.</span>
            </div>
          ),
        });
        if (ok) await save(true);
        return;
      }
      setLintErrors(null);
    }
  };

  const toggleRole = (r: string) => setAppliesTo((xs) => (xs.includes(r) ? xs.filter((x) => x !== r) : [...xs, r]));
  const overLimit = body.length > SKILL_MAX_BODY || (inline && body.length > SKILL_MAX_INLINE_BODY);

  return (
    <Modal open onClose={onClose} size="xl" icon="pencil" title={isNew ? 'New skill' : `Edit · ${entry!.skill.name}`} subtitle={subtitle}>
      <div className="apb-fields">
        <Field label="Name" hint={isNew ? 'a–z, 0–9, - · 3–48' : 'read-only'}>
          <input className="input-field apb-input apb-mono" value={name} readOnly={!isNew} disabled={!isNew}
            spellCheck={false} autoCapitalize="none" placeholder="my-skill" onChange={(e) => setName(e.target.value.toLowerCase())} />
          {isNew && name && !NAME_RE.test(name.trim()) && <div className="text-micro apb-bad apb-gap-top-sm">3–48 chars: a–z, 0–9 and -</div>}
          {clash && <div className="text-micro apb-warn apb-gap-top-sm">
            {clash.origin === 'builtin' || clash.origin === 'global' ? 'A shared skill has this name — saving creates an override.' : 'This agent already has a skill with this name — saving writes a new version.'}
          </div>}
        </Field>
        <Field label="Description" hint={`${description.trim().length} / 300 · min 10`}>
          <input className="input-field apb-input" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>
      <Field label="Applies to" hint="roles that load this skill">
        <div className="apb-chips">
          {SKILL_ROLES.map((r) => (
            <button key={r} type="button" className="chip-toggle mono" aria-pressed={appliesTo.includes(r)} onClick={() => toggleRole(r)}>{r}</button>
          ))}
        </div>
      </Field>
      <div className="apb-body-head">
        <span className="text-eyebrow">Body</span>
        <span className={`text-micro mono tabular-nums ${overLimit ? 'apb-bad' : 'apb-dim'}`}>
          {body.length.toLocaleString()} / {SKILL_MAX_BODY.toLocaleString()}{inline ? ` · always-in-context limit ${SKILL_MAX_INLINE_BODY.toLocaleString()}` : ''}
        </span>
        <button type="button" className="btn-tiny" onClick={() => setPreview((v) => !v)}>
          <Icon name="eye" size={12} />&nbsp;{preview ? 'Hide preview' : 'Preview'}
        </button>
      </div>
      <div className={`apb-editor${preview ? ' has-preview' : ''}`}>
        <textarea className="input-field apb-body-input" aria-label="Skill body" value={body} spellCheck={false} onChange={(e) => { setBody(e.target.value); setLintErrors(null); }} />
        {preview && (
          <div className="inset apb-preview" aria-label="Preview">
            {body.trim() ? <MarkdownPreview text={body} /> : <span className="text-micro apb-dim">Preview appears here.</span>}
          </div>
        )}
      </div>

      {lintErrors && lintErrors.length > 0 && (
        <div className="callout-danger apb-callout-col apb-gap-top">
          <strong className="text-body-sm">The skill linter refused this text</strong>
          <ul className="apb-list">
            {lintErrors.map((e, i) => (
              <li key={i}>
                <code className="mono">{e.code}</code>{e.hard ? <> <Badge tone="danger">hard</Badge></> : null} — {e.message}
              </li>
            ))}
          </ul>
          {!forceable && <span className="text-micro apb-muted">Fix the text — these checks cannot be overridden.</span>}
        </div>
      )}
      {put.error && !lintErrors && errorBody(put.error)?.error !== 'safety_skill' && (
        <div className="callout-danger apb-gap-top">{describeError(put.error)}</div>
      )}

      <div className="modal-foot apb-foot">
        <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
        {forceable && <button type="button" className="btn-danger" disabled={put.isPending} onClick={() => save(true)}>Save anyway</button>}
        <button type="button" className="btn-primary" disabled={put.isPending || errors.length > 0} onClick={() => save(false)}>
          {put.isPending ? 'Saving…' : isNew ? 'Create skill' : shared ? 'Save override' : 'Save version'}
        </button>
      </div>
    </Modal>
  );
}

/** A small markdown-ish renderer: headings, lists, code fences, quotes, **bold**, `code`. */
function MarkdownPreview({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const lines = text.split('\n');
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  const flushPara = () => { if (para.length) { out.push(<p key={out.length} className="apb-md-p">{inline(para.join(' '))}</p>); para = []; } };
  const flushList = () => {
    if (!list) return;
    const Tag = list.ordered ? 'ol' : 'ul';
    out.push(<Tag key={out.length} className="apb-md-list">{list.items.map((t, i) => <li key={i}>{inline(t)}</li>)}</Tag>);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      flushPara(); flushList();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith('```'); i++) code.push(lines[i]);
      out.push(<pre key={out.length} className="code-block apb-md-pre">{code.join('\n')}</pre>);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (h) {
      flushPara(); flushList();
      out.push(<div key={out.length} className={`apb-md-h is-h${h[1].length}`}>{inline(h[2])}</div>);
    } else if (li) {
      flushPara();
      const ordered = /\d/.test(li[1]);
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push(li[2]);
    } else if (line.startsWith('>')) {
      flushPara(); flushList();
      out.push(<blockquote key={out.length} className="apb-md-quote">{inline(line.replace(/^>\s?/, ''))}</blockquote>);
    } else if (!line.trim()) {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara(); flushList();
  return <div className="apb-md">{out}</div>;
}

function inline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={i} className="apb-md-code">{part.slice(1, -1)}</code>;
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

// ── versions ────────────────────────────────────────────────────────────────

type DiffLine = { t: ' ' | '+' | '-'; s: string };

/** Line diff via LCS (skill bodies are ≤ 12 000 chars, so O(n·m) is fine). */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split('\n'), y = b.split('\n');
  const n = x.length, m = y.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ t: ' ', s: x[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: '-', s: x[i++] });
    else out.push({ t: '+', s: y[j++] });
  }
  while (i < n) out.push({ t: '-', s: x[i++] });
  while (j < m) out.push({ t: '+', s: y[j++] });
  return out;
}

export function DiffView({ from, to }: { from: string; to: string }) {
  const lines = useMemo(() => lineDiff(from, to), [from, to]);
  const changed = lines.filter((l) => l.t !== ' ').length;
  // Collapse long unchanged stretches to 2 lines of context.
  const keep = lines.map((l, i) => l.t !== ' ' || lines.slice(Math.max(0, i - 2), i + 3).some((k) => k.t !== ' '));
  const rows: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) {
      let k = i; while (k < lines.length && !keep[k]) k++;
      if (k - i < 3) { for (let j = i; j < k; j++) keep[j] = true; i--; continue; }
      rows.push(<div key={`gap${i}`} className="apb-diff-line is-gap">⋯ {k - i} unchanged</div>);
      i = k - 1; continue;
    }
    const l = lines[i];
    rows.push(
      <div key={i} className={`apb-diff-line${l.t === '+' ? ' is-add' : l.t === '-' ? ' is-del' : ''}`}>{l.t} {l.s || ' '}</div>,
    );
  }
  return (
    <div>
      <div className="text-micro apb-dim apb-diff-head">{changed === 0 ? 'Body unchanged' : `${changed} changed line${changed === 1 ? '' : 's'}`}</div>
      {changed > 0 && <div className="code-block apb-diff">{rows}</div>}
    </div>
  );
}

function VersionsModal({ entry, onClose }: { entry: AgentSkillEntry; onClose: () => void }) {
  const q = useSkillVersions(entry.skill.id);
  const rollback = useRollbackSkill();
  const confirm = useConfirm();
  const [diffOf, setDiffOf] = useState<number | null>(null);
  const [probeOf, setProbeOf] = useState<number | null>(null);
  const skill = q.data?.skill ?? entry.skill;
  const versions = [...(q.data?.versions ?? [])].sort((a, b) => b.version - a.version);
  const canRollback = skill.scope !== 'builtin' && entry.origin !== 'inherited';
  // A version that never went live (probing / rejected) is compared with the text that is live; the others with the
  // version before them that was live.
  const wasLive = (x: SkillVersion) => x.outcome !== 'probing' && x.outcome !== 'rejected';
  const prevOf = (v: SkillVersion) => (wasLive(v) ? versions.find((x) => x.version < v.version && wasLive(x)) : versions.find((x) => x.version === skill.currentVersion));
  const probeV = probeOf != null ? versions.find((x) => x.version === probeOf) ?? null : null;
  const diffV = diffOf != null ? versions.find((x) => x.version === diffOf) ?? null : null;
  const diffPrev = diffV ? prevOf(diffV) : undefined;

  return (
    <>
    <Modal open onClose={onClose} size="lg" icon="history" title={`Versions · ${skill.name}`}
      subtitle={`Current v${skill.currentVersion}${canRollback ? '' : skill.scope === 'builtin' ? ' · built-in skills change only in the repository' : ' · roll back from the orchestrator'}`}>
      {q.error && <div className="callout-danger">{describeError(q.error)}</div>}
      {!q.data && !q.error && <div className="apb-skeleton" style={{ height: 80 }} aria-hidden />}
      {q.data && versions.length === 0 && <EmptyState icon="history" title="No versions recorded" />}
      {versions.length > 0 && (
        <div className="panel is-flush">
          {versions.map((v) => {
            const current = v.version === skill.currentVersion;
            const prev = prevOf(v);
            return (
              <div key={v.id} className={`panel-row apb-version${current ? ' is-selected' : ''}`}>
                <div className="apb-version-line">
                  <span className="apb-ver mono tabular-nums">v{v.version}</span>
                  {current && <Badge tone="accent">current</Badge>}
                  <Badge tone={AUTHOR_TONE[v.author]}>{v.author}</Badge>
                  {v.outcome && v.outcome !== 'probing' && v.outcome !== 'rejected' && <Badge tone={OUTCOME_TONE[v.outcome] ?? 'neutral'} title={v.reviewAt ? `review ${fmtDate(v.reviewAt)}` : undefined}>{v.outcome.replace('_', ' ')}</Badge>}
                  {(() => { const pb = probeBadge(v); return pb ? <Badge tone={pb.tone} title={pb.title}>{pb.label}</Badge> : null; })()}
                  <span className="text-micro mono tabular-nums apb-dim">{fmtDate(v.createdAt)}</span>
                  <span className="apb-actions apb-version-actions">
                    {(hasProbeDetails(v) || v.outcome === 'probing' || v.outcome === 'rejected') && (
                      <TableAction icon="eye" title="Probe: old and new text side by side" onClick={() => setProbeOf(v.version)} />
                    )}
                    <TableAction icon="logs" title={prev ? `Diff vs v${prev.version}` : 'Show text'} onClick={() => setDiffOf(v.version)} />
                    {canRollback && !current && v.outcome !== 'probing' && (
                      <TableAction icon="refresh" title={`Roll back to v${v.version}`} disabled={rollback.isPending}
                        onClick={async () => {
                          if (await confirm(`roll “${skill.name}” back to v${v.version}`, { danger: false, confirmLabel: 'Roll back', details: (
                            <p className="text-micro apb-note">A new version v{Math.max(...versions.map((x) => x.version)) + 1} is created with the text of v{v.version}; history is kept.</p>
                          ) })) rollback.mutate({ id: skill.id, version: v.version });
                        }} />
                    )}
                  </span>
                </div>
                {(v.reason || v.reviewAt) && (
                  <div className="text-micro apb-muted">
                    {v.reason}{v.reviewAt && v.outcome === 'pending' ? ` · KPI review ${fmtDate(v.reviewAt)}` : ''}
                  </div>
                )}
                {probeSummary(v.probe) && (
                  <div className="text-micro apb-muted">Probe: {probeSummary(v.probe)}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="modal-foot">
        <button type="button" className="btn-ghost" onClick={onClose}>Close</button>
      </div>
    </Modal>
    {diffV && (
      <Modal open onClose={() => setDiffOf(null)} size="lg" icon="logs"
        title={diffPrev ? `v${diffV.version} vs v${diffPrev.version}` : `Text of v${diffV.version}`}
        subtitle={`${skill.name} · ${diffV.author} · ${fmtDate(diffV.createdAt)}`}>
        {diffPrev
          ? <DiffView from={diffPrev.body} to={diffV.body} />
          : <pre className="code-block apb-text">{diffV.body}</pre>}
        <div className="modal-foot">
          <button type="button" className="btn-ghost" onClick={() => setDiffOf(null)}>Close</button>
        </div>
      </Modal>
    )}
    {probeV && (
      <SkillProbeDialog skillId={skill.id} skillName={skill.name} version={probeV}
        newest={canAdoptAnyway(probeV, versions)} onClose={() => setProbeOf(null)} />
    )}
    </>
  );
}
