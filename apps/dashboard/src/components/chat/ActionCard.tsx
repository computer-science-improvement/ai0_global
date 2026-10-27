// A confirmation card from an agent in the chat (spec 018 FR-005), compact: what
// the agent proposes (create an agent, change one, write a skill…); its dialog has
// the full payload and the owner's [Apply] / [Discard]. Nothing changes until Apply; the server re-validates the
// card against the current state, so a stale card comes back `failed` with the
// reason. Decided cards show their final status.

import { Link } from '@tanstack/react-router';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { Badge } from '../ui/Badge';
import { Icon, type IconName } from '../ui/Icon';
import type { Tone } from '../ui/primitives';
import { describeError, toast } from '../ui/Toast';
import { fmtDate, fmtRelative } from '../../lib/format';
import { KPI_GOALS, useDecideAction, type KpiGoal } from '../../api/agents';
import type { PendingAction, PendingActionStatus } from '../../api/types';
import { choiceInput, initialState, parsePayload, type ContentExamplesState } from '../../lib/content-examples';
import { ContentExamplesBody, examplesCardLine } from './ContentExamplesCard';
import { CompactCard } from '../ui/CompactCard';
import { resolverItemLines } from '../../lib/align';
import { followUpInput, followUpLabel, followUpsOf, initialSkip, outcomeBadge, outcomesOf, type FollowUp } from '../../lib/follow-ups';

const KIND_META: Record<string, { label: string; icon: IconName }> = {
  create_agent:         { label: 'Create agent',      icon: 'sparkles' },
  update_agent:         { label: 'Update agent',      icon: 'pencil' },
  set_brief:            { label: 'Set brief',         icon: 'logs' },
  set_resource_profile: { label: 'Resource profile',  icon: 'globe' },
  write_skill:          { label: 'Write skill',       icon: 'book' },
  attach_skill:         { label: 'Attach skill',      icon: 'plus' },
  detach_skill:         { label: 'Detach skill',      icon: 'ban' },
  edit_data_schema:     { label: 'Edit dataset', icon: 'database' },
  content_examples:     { label: 'Example posts', icon: 'book' },
  owner_rule:           { label: 'Owner rule', icon: 'logs' },
  fix_config_conflicts: { label: 'Align with your rules', icon: 'wrench' },
  slot_change:          { label: 'Change a slot', icon: 'clock' },
  slot_regenerate:      { label: 'Write the post now', icon: 'play' },
  replan_today:         { label: 'Replan today', icon: 'calendar-sync' },
  update_artifact:      { label: 'Change an artifact', icon: 'pencil' },
  import_list:          { label: 'Import a list into a dataset', icon: 'database' },
  resync_import:        { label: 'Re-sync an imported list', icon: 'database' },
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

/** Spec 034 FR-007: the formats @ai0 picked, each with why it fits (absent = the text + photo default). */
export function formatsOf(p: Record<string, unknown>): Array<{ format: string; reason: string | null }> {
  return Array.isArray(p.formats)
    ? p.formats.map((f) => ({ format: str(obj(f).format) ?? '?', reason: str(obj(f).reason) })).filter((f) => f.format !== '?')
    : [];
}

/** Long payload text, shown whole (the payload is only rendered in the card's dialog). */
function LongText({ text }: { text: string }) {
  return <span style={{ whiteSpace: 'pre-wrap' }}>{text}</span>;
}

function CreateAgentView({ p }: { p: Record<string, unknown> }) {
  const profile = obj(p.profile);
  const aud = obj(profile.audience);
  const who = [str(aud.who), str(aud.age), str(aud.region)].filter(Boolean).join(' · ');
  const handle = str(p.handle)?.replace(/^@/, '');
  const formats = formatsOf(p);
  const taboo = strs(profile.taboo);
  const banned = strs(p.banned_terms);
  const times = strs(obj(p.schedule).times);
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
      <Row label="Brief">{str(p.brief) ? <LongText text={p.brief as string} /> : <span style={{ color: 'var(--color-ink-dim)' }}>none — the profile is the brief</span>}</Row>
      {str(profile.tone) && <Row label="Tone">{profile.tone as string}</Row>}
      <Row label="Taboo topics">{taboo.length ? taboo.join(', ') : '—'}</Row>
      {banned.length > 0 && <Row label="Banned words">{banned.join(', ')}</Row>}
      <Row label="Formats">
        {formats.length ? (
          <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {formats.map((f) => (
              <span key={f.format}><span className="chip" style={{ marginRight: 6 }}>{f.format}</span>{f.reason ?? ''}</span>
            ))}
          </span>
        ) : <span><span className="chip">text</span> <span className="chip">photo</span> <span style={{ color: 'var(--color-ink-dim)' }}>default</span></span>}
      </Row>
      <Row label="Schedule">{times.length ? `orchestrator runs at ${times.join(', ')} (Kyiv)` : 'orchestrator runs at 06:30 (Kyiv)'}</Row>
      <Row label="Mode"><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}><span style={{ flexShrink: 0, whiteSpace: 'nowrap' }}><Badge tone="warning">approval</Badge></span> Starts in approval mode: every post waits for your approval</span></Row>
    </>
  );
}

function SetBriefView({ p }: { p: Record<string, unknown> }) {
  return (
    <>
      {str(p.handle) && <Row label="Agent">@{p.handle as string}</Row>}
      {str(p.brief) && <Row label="Brief"><LongText text={p.brief as string} /></Row>}
      <Row label="Then">the orchestrator rebuilds the playbook from this brief</Row>
    </>
  );
}

/** Spec 040 FR-010: a rule whose words did not match the chat closely — the owner checks it against their own messages. */
function OwnerRuleView({ p }: { p: Record<string, unknown> }) {
  const quotes = strs(p.quotes);
  return (
    <>
      {str(p.channel) && <Row label="Channel">{p.channel as string}</Row>}
      {str(p.text) && <Row label={p.kind === 'avoid' ? 'Avoid' : 'Rule'}><LongText text={p.text as string} /></Row>}
      {quotes.length > 0 && (
        <Row label="Your words">
          <span style={{ display: 'grid', gap: 4 }}>
            {quotes.map((q, i) => (
              <span key={i} style={{ color: 'var(--color-ink-muted)', borderLeft: '2px solid var(--color-hairline)', paddingLeft: 8 }}><LongText text={q} /></span>
            ))}
          </span>
        </Row>
      )}
      <Row label="Then">the rule goes into the channel memory and applies to every run</Row>
    </>
  );
}

/** Spec 047 FR-005: the owner's ticks on a resolver card (unticked keys are skipped at Apply). */
const ResolverSkipContext = createContext<{ skip: string[]; toggle: (key: string) => void; pending: boolean } | null>(null);
const ITEM_KIND_LABEL: Record<string, string> = { pending_playbook: 'Playbook', junk_rule: 'Rule', conflict: 'Conflict' };

/** Spec 040 FR-011 / 047 FR-005: what the card changes — each item can be unticked before Apply. */
function FixConflictsView({ p }: { p: Record<string, unknown> }) {
  const ctx = useContext(ResolverSkipContext);
  const items = Array.isArray(p.items) ? p.items.map(obj) : null;
  if (items) {
    return (
      <>
        {str(p.handle) && <Row label="Agent">@{p.handle as string}</Row>}
        <Row label="Items">
          <span style={{ display: 'grid', gap: 6 }}>
            {items.map((it) => {
              const key = str(it.key) ?? '';
              const on = !ctx?.skip.includes(key);
              return (
                <label key={key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: ctx?.pending ? 'pointer' : 'default', opacity: on ? 1 : 0.55 }}>
                  <input type="checkbox" checked={on} disabled={!ctx?.pending} onChange={() => ctx?.toggle(key)} style={{ marginTop: 3 }} aria-label={str(it.detail) ?? key} />
                  <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                    <Badge tone={it.kind === 'conflict' ? 'warning' : it.kind === 'junk_rule' ? 'danger' : 'accent'}>{ITEM_KIND_LABEL[str(it.kind) ?? ''] ?? str(it.kind)}</Badge>{' '}
                    {str(it.detail) ?? key}
                  </span>
                </label>
              );
            })}
          </span>
        </Row>
        <Row label="Then">ticked items apply in this order: the playbook draft goes live, the rules are retired, the conflicts are fixed (recomputed at Apply)</Row>
      </>
    );
  }
  const list = Array.isArray(p.conflicts) ? p.conflicts.map(obj) : [];
  return (
    <>
      {str(p.handle) && <Row label="Agent">@{p.handle as string}</Row>}
      <Row label="Fixes">
        <ul style={{ margin: 0, paddingLeft: 16, display: 'grid', gap: 4 }}>
          {list.map((c, i) => <li key={i} style={{ overflowWrap: 'anywhere' }}>{str(c.detail) ?? str(c.code) ?? '—'}</li>)}
        </ul>
      </Row>
      <Row label="Then">a new playbook version (yours) and profile updates, recomputed at Apply</Row>
    </>
  );
}

/** Spec 069 FR-001: the owner's ticks on a card's follow-ups (unticked keys are skipped at Apply). */
const FollowUpsContext = createContext<{ skip: string[]; toggle: (key: string) => void; pending: boolean } | null>(null);

/**
 * Spec 069 FR-001: what runs after the main action of a card — a ticked checklist while the card waits, and each item's
 * outcome once it is decided (the card stays applied when one of them fails).
 */
function FollowUpsView({ action, items }: { action: PendingAction; items: FollowUp[] }) {
  const ctx = useContext(FollowUpsContext);
  if (!items.length) return null;
  const decided = action.status === 'applied';
  const outcomes = new Map(outcomesOf(action.result).map((o) => [o.key, o]));
  return (
    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>
        {decided ? 'Then' : 'Then, in this order — untick what you do not want'}
      </span>
      <span style={{ display: 'grid', gap: 6 }}>
        {items.map((it) => {
          const on = !ctx?.skip.includes(it.key);
          const badge = outcomeBadge(outcomes.get(it.key));
          return (
            <label key={it.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: ctx?.pending ? 'pointer' : 'default', opacity: ctx?.pending && !on ? 0.55 : 1 }}>
              {!decided && <input type="checkbox" checked={on} disabled={!ctx?.pending} onChange={() => ctx?.toggle(it.key)} style={{ marginTop: 3 }} aria-label={it.summary} />}
              <span className="text-body-sm" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                <Badge tone="accent">{followUpLabel(it.kind)}</Badge>{' '}
                {it.summary}
                {decided && (
                  <>
                    {' '}<Badge tone={badge.tone}>{badge.text}</Badge>
                    {badge.detail && <span className="text-micro" style={{ color: 'var(--color-danger)', display: 'block' }}>{badge.detail}</span>}
                  </>
                )}
              </span>
            </label>
          );
        })}
      </span>
    </div>
  );
}

function ExamplesResult({ result }: { result: unknown }) {
  const r = obj(result);
  const saved = typeof r.saved === 'number' ? r.saved : null;
  const where = r.target === 'active' ? `playbook v${String(r.version)}`
    : r.target === 'pending' ? `the playbook draft v${String(r.version)} waiting for your approval`
      : r.target === 'held' ? 'the first playbook (it is still being built)' : 'the playbook';
  return (
    <p className="text-micro" style={{ margin: '10px 0 0', color: 'var(--color-ink-muted)' }}>
      Saved {saved ?? 'the'} examples to {where}.
    </p>
  );
}

const STOP_TEXT: Record<string, string> = {
  failed: 'a failed page', max_pages: 'the page limit', max_rows: 'the row limit', pages: 'the pages asked for', no_new: 'a page with nothing new',
};

/** What an applied list import wrote, and where a paged API stopped short of its end. */
function ImportResultView({ result }: { result: unknown }) {
  const r = obj(result);
  const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0);
  const read = typeof r.pages_read === 'number' ? r.pages_read : null;
  const total = typeof r.pages_total === 'number' ? r.pages_total : null;
  const stop = str(r.stopped);
  const short = read != null && stop && STOP_TEXT[stop] && (total == null || read < total);
  return (
    <p className="text-micro" style={{ margin: '10px 0 0', color: 'var(--color-ink-muted)', overflowWrap: 'anywhere' }}>
      {n('inserted')} added, {n('updated')} updated, {n('skipped')} unchanged{n('not_postable') ? `, ${n('not_postable')} not postable` : ''}{str(r.dataset) ? ` in ${r.dataset as string}` : ''}.
      {short && ` Read ${read}${total != null ? ` of ${total}` : ''} pages: stopped at ${STOP_TEXT[stop]}${stop === 'failed' && str(r.failure) ? ` (${r.failure as string})` : ''}.`}
    </p>
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
        <div>
          <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>
            Body · {body.length.toLocaleString('en-US')} chars
          </span>
          <pre className="text-micro" style={{
            margin: '6px 0 0', padding: 10, maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            background: 'var(--color-canvas)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-sm)',
            color: 'var(--color-ink-muted)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          }}>{body}</pre>
        </div>
      )}
    </>
  );
}

/** Spec 048 FR-002: an agent's change to a live artifact (steering, owner rules, a skill…), as the type's patch. */
function UpdateArtifactView({ p }: { p: Record<string, unknown> }) {
  return (
    <>
      {str(p.title) && <Row label="Artifact">{p.title as string}</Row>}
      {str(p.reason) && <Row label="Why"><LongText text={p.reason as string} /></Row>}
      <Row label="Change">
        <pre className="text-micro" style={{
          margin: 0, padding: 10, maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          background: 'var(--color-canvas)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-sm)',
          color: 'var(--color-ink-muted)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}>{JSON.stringify(p.patch ?? {}, null, 2)}</pre>
      </Row>
      <Row label="Then">the artifact gets a new version; the change is checked again at Apply</Row>
    </>
  );
}

function PayloadView({ action }: { action: PendingAction }) {
  const p = obj(action.payload);
  if (action.kind === 'create_agent') return <CreateAgentView p={p} />;
  if (action.kind === 'update_agent') return <UpdateAgentView p={p} />;
  if (action.kind === 'write_skill') return <WriteSkillView p={p} />;
  if (action.kind === 'set_brief') return <SetBriefView p={p} />;
  if (action.kind === 'owner_rule') return <OwnerRuleView p={p} />;
  if (action.kind === 'fix_config_conflicts') return <FixConflictsView p={p} />;
  if (action.kind === 'update_artifact') return <UpdateArtifactView p={p} />;
  return null;
}

const BOXED = new Set(['create_agent', 'update_agent', 'write_skill', 'set_brief', 'owner_rule', 'fix_config_conflicts', 'update_artifact']);

/**
 * An agent's confirmation card as a compact card: what it proposes, its status and two lines of the summary.
 * A click opens the dialog with the full payload (and the example posts to mark) and Apply / Discard.
 */
/** The card a deep link points at (`/app/chat?c=…&card=…`, from "Waiting for you"): it scrolls into view and opens. */
export const FocusedCardContext = createContext<string | undefined>(undefined);

export function ActionCard({ action }: { action: PendingAction }) {
  const focusedId = useContext(FocusedCardContext);
  const decide = useDecideAction();
  // The decision's response until the chat refetch brings the same status.
  const [local, setLocal] = useState<PendingAction | null>(null);
  const a = action.status === 'pending' && local ? local : action;
  const meta = KIND_META[a.kind] ?? { label: a.kind.replace(/_/g, ' '), icon: 'wrench' as IconName };
  const pending = a.status === 'pending';
  const createdHandle = a.kind === 'create_agent' && a.status === 'applied' ? str(obj(a.result).handle) : null;
  // Spec 034 FR-008: the example-posts card keeps the owner's verdicts and edits until Apply (here, across dialog openings).
  const examples = useMemo(() => (a.kind === 'content_examples' ? parsePayload(a.payload) : null), [a.kind, a.payload]);
  const [choices, setChoices] = useState<ContentExamplesState | null>(() => (examples ? initialState(examples) : null));
  // Spec 047 FR-005: the resolver card's unticked items.
  const [skip, setSkip] = useState<string[]>([]);
  const resolver = a.kind === 'fix_config_conflicts' && Array.isArray(obj(a.payload).items);
  const toggle = (key: string) => setSkip((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));
  // Spec 069 FR-001: follow-ups run after the main action; the owner's ticks go out as input.skip_then (soft ones start unticked).
  const followUps = useMemo(() => followUpsOf(a.payload), [a.payload]);
  const [thenSkip, setThenSkip] = useState<string[]>(() => initialSkip(followUps));
  const toggleThen = (key: string) => setThenSkip((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));

  const applyInput = () => {
    const input = {
      ...(examples && choices ? choiceInput(examples, choices) : {}),
      ...(resolver && skip.length ? { skip } : {}),
      ...(followUpInput(followUps, thenSkip) ?? {}),
    };
    return Object.keys(input).length ? { input } : {};
  };

  const run = (decision: 'apply' | 'discard', onDone: () => void) => decide.mutate({
    id: a.id, decision,
    ...(decision === 'apply' ? applyInput() : {}),
  }, {
    onSuccess: (r) => {
      setLocal(r.action);
      if (r.action.status === 'applied') toast.success(`Applied: ${meta.label.toLowerCase()}`);
      else if (r.action.status === 'failed') toast.error(`Not applied: ${r.action.error ?? 'failed'}`);
      else if (r.action.status === 'expired') toast.error('This card has expired — ask the agent again');
      // Applied or discarded: the card is settled. Failed / expired stay open with the reason.
      if (r.action.status === 'applied' || r.action.status === 'discarded') onDone();
    },
  });

  const examplesLine = examples ? examplesCardLine(examples, pending) : null;
  // Spec 062 FR-008: the resolver card's bubble lists what it will change.
  const resolverLines = resolver ? resolverItemLines(a.payload) : null;
  // Spec 069: the follow-ups listed in the chat bubble the same way (the dialog has them all, each with a checkbox).
  const followLines = followUps.length ? { lines: followUps.slice(0, 3).map((f) => f.summary.replace(/\s+/g, ' ')), more: Math.max(0, followUps.length - 3) } : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 560, minWidth: 0 }}>
      <CompactCard hint="Open the card" attention={pending} focused={focusedId === a.id}
        top={<>
          <span className="section-glyph" style={{ width: 22, height: 22 }}><Icon name={meta.icon} size={12} /></span>
          <span className="text-caption" style={{ color: 'var(--color-ink)', fontWeight: 600 }}>{meta.label}</span>
          <Badge tone={ACTION_TONE[a.status] ?? 'neutral'}>{pending ? 'needs your confirmation' : a.status}</Badge>
        </>}
        meta={!pending && a.decidedAt ? <span title={fmtDate(a.decidedAt)}>{fmtRelative(a.decidedAt)}</span> : undefined}
        title={examplesLine ?? undefined}
        body={a.summary || undefined}
        extra={resolverLines ? <ResolverLines lines={resolverLines.lines} more={resolverLines.more} />
          : followLines ? <ResolverLines lines={followLines.lines} more={followLines.more} /> : undefined}
        note={a.status === 'failed' && a.error ? a.error : undefined}
        noteTone="danger"
        dialog={{
          size: examples ? 'xl' : 'lg', icon: meta.icon, title: meta.label,
          subtitle: pending ? 'Nothing changes until you apply' : `${a.status}${a.decidedAt ? ` · ${fmtRelative(a.decidedAt)}` : ''}`,
          body: () => (
            <ResolverSkipContext.Provider value={{ skip, toggle, pending }}>
              <FollowUpsContext.Provider value={{ skip: thenSkip, toggle: toggleThen, pending }}>
                <ActionDetails a={a} pending={pending} createdHandle={createdHandle} error={decide.error}
                  examples={examples && choices ? <ContentExamplesBody payload={examples} state={choices} onChange={setChoices} pending={pending} /> : null} />
              </FollowUpsContext.Provider>
            </ResolverSkipContext.Provider>
          ),
          actions: pending ? (close) => (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', width: '100%' }}>
              <span className="text-micro" style={{ color: 'var(--color-ink-dim)', marginRight: 'auto' }}>Nothing changes until you apply</span>
              <button className="btn-secondary" disabled={decide.isPending} onClick={() => run('discard', close)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Icon name="x" size={14} /> Discard
              </button>
              <button className="btn-primary" disabled={decide.isPending} onClick={() => run('apply', close)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Icon name="check" size={14} /> Apply
              </button>
            </div>
          ) : undefined,
        }} />
      {createdHandle && <CreatedLink handle={createdHandle} />}
    </div>
  );
}

/** The first items of a resolver card, in the chat bubble (the dialog has them all, each with a checkbox). */
function ResolverLines({ lines, more }: { lines: string[]; more: number }) {
  if (!lines.length) return null;
  return (
    <span className="text-micro" style={{ display: 'grid', gap: 2, color: 'var(--color-ink-muted)', textAlign: 'left' }}>
      {lines.map((l, i) => <span key={i} className="clamp" style={{ ['--clamp' as string]: 1 }}>• {l}</span>)}
      {more > 0 && <span style={{ color: 'var(--color-ink-dim)' }}>+ {more} more</span>}
    </span>
  );
}

function CreatedLink({ handle }: { handle: string }) {
  return (
    <div>
      <Link to="/app/agents/$handle" params={{ handle }} className="link-accent text-body-sm"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        Open @{handle} <Icon name="chevron-right" size={14} />
      </Link>
      <span className="text-micro" style={{ color: 'var(--color-ink-dim)', marginLeft: 8 }}>Starts in approval mode</span>
    </div>
  );
}

/** The dialog body: the summary, the payload rows, the example posts, the result and the errors. */
function ActionDetails({ a, pending, createdHandle, error, examples }: {
  a: PendingAction; pending: boolean; createdHandle: string | null; error: unknown; examples: ReactNode;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <Badge tone={ACTION_TONE[a.status] ?? 'neutral'}>{pending ? 'needs your confirmation' : a.status}</Badge>
        {!pending && a.decidedAt && (
          <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }} title={fmtDate(a.decidedAt)}>{fmtRelative(a.decidedAt)}</span>
        )}
      </div>

      <p className="text-body-sm" style={{ margin: '0 0 10px', color: 'var(--color-ink)', lineHeight: 1.5, overflowWrap: 'anywhere' }}>{a.summary}</p>

      {BOXED.has(a.kind) && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 6, padding: 12,
          background: 'var(--color-surface-1)', border: '1px solid var(--color-hairline-soft)', borderRadius: 'var(--radius-lg)',
        }}>
          <PayloadView action={a} />
        </div>
      )}
      {examples}
      {a.kind === 'content_examples' && a.status === 'applied' && <ExamplesResult result={a.result} />}
      {(a.kind === 'import_list' || a.kind === 'resync_import') && a.status === 'applied' && <ImportResultView result={a.result} />}
      <FollowUpsView action={a} items={followUpsOf(a.payload)} />

      {a.status === 'failed' && a.error && (
        <div className="callout-danger" style={{ marginTop: 10 }}><span className="text-micro" style={{ overflowWrap: 'anywhere' }}>{a.error}</span></div>
      )}
      {error != null && (
        <div className="callout-danger" style={{ marginTop: 10 }}><span className="text-micro">{describeError(error)}</span></div>
      )}
      {createdHandle && <div style={{ marginTop: 10 }}><CreatedLink handle={createdHandle} /></div>}
    </div>
  );
}
