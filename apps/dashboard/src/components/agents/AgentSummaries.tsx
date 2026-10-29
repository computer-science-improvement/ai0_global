// Spec 078 D6 / B3.3: the two compact summaries on an orchestrator's Overview. Both link to the Settings leaf, where the full
// forms live (ResourceSection, FormattingSection).
//   Channel          the resource: its ref, its health and the health detail, the key facts of the profile.
//   How posts look   the four fields the agent evolves (hashtags, links, emoji, preferred formats) each with an owner Lock
//                    switch (a locked field is read-only to agents), what the channel card fixes, read-only.

import { Link } from '@tanstack/react-router';
import { SectionCard } from '../ui/primitives';
import { Icon } from '../ui/Icon';
import { describeError, toast } from '../ui/Toast';
import { GoalChips } from '../chat/ActionCard';
import { HealthBadge, useResourceClock } from './ResourceProfile';
import { errorText } from './NetworkUi';
import { fmtRelative } from '../../lib/format';
import { formatIn } from '../../lib/zoned-time';
import { formatRows, lockSummary, toggleLock } from '../../lib/agent-overview';
import { FORMAT_LABEL } from '../../lib/format-prefs';
import { errorBody, usePutResourceFormatting, useResourceFormatting, useResourceProfile, type FormatPrefField } from '../../api/agents';
import { useEditorChannel } from '../../api/editor';

function SettingsLink({ handle, children }: { handle: string; children: string }) {
  return <Link to="/app/agents/$handle" params={{ handle }} search={{ tab: 'settings' }} className="panel-link">{children}</Link>;
}

// ── Channel ──────────────────────────────────────────────────────────────────

export function ChannelSummary({ handle, delay }: { handle: string; delay?: number }) {
  const q = useResourceProfile(handle);
  const d = q.data;
  const p = d?.profile ?? null;
  const clock = useResourceClock(handle, d?.ref ?? null, p);
  return (
    <SectionCard title="Channel" icon="globe" delay={delay} action={<SettingsLink handle={handle}>Edit in Settings →</SettingsLink>}>
      {q.error && <div className="callout-danger">{describeError(q.error)}</div>}
      {!d && !q.error && <div className="summary-skeleton" aria-hidden />}
      {d && (
        <div className="agent-facts">
          <div className="agent-facts-head">
            {d.ref && <code className="chip mono clamp" title={d.ref}>{d.ref}</code>}
            <HealthBadge health={d.health} />
            {d.health && <span className="text-micro agent-dim">checked {fmtRelative(d.health.checkedAt)}</span>}
          </div>
          {d.health?.detail && <p className="text-body-sm agent-muted clamp" title={d.health.detail}>{d.health.detail}</p>}
          {p ? (
            <div className="agent-facts-grid">
              <div className="agent-fact agent-fact-wide"><span className="text-overline">Topic</span><span className="clamp" title={p.topic}>{p.topic}</span></div>
              <div className="agent-fact"><span className="text-overline">Language</span><span><span className="chip">{p.language}</span></span></div>
              <div className="agent-fact"><span className="text-overline">Goals</span><GoalChips goals={p.goals} /></div>
              <div className="agent-fact">
                <span className="text-overline">Time zone</span>
                <span className="tabular-nums">{clock.timezone}<span className="agent-dim"> · now {formatIn(new Date(), clock.timezone)}</span></span>
              </div>
            </div>
          ) : (
            <p className="text-body-sm agent-muted">The resource is not described yet. Describe it in Settings so the agent knows what it is about.</p>
          )}
        </div>
      )}
    </SectionCard>
  );
}

// ── How posts look ───────────────────────────────────────────────────────────

export function FormattingSummary({ handle, scopeRef, channelKey, delay }: { handle: string; scopeRef: string | null; channelKey: string | null; delay?: number }) {
  const q = useResourceFormatting(handle);
  const put = usePutResourceFormatting(handle);
  const card = useEditorChannel(channelKey ?? '').data;
  const d = q.data;
  const r = d ? d.resources.find((x) => x.ref === scopeRef) ?? d.resources[0] : undefined;

  // The switch is its own way back (click again), so no Undo toast: a stale Undo would replace what an agent changed since.
  const flip = async (field: FormatPrefField) => {
    if (!r) return;
    // The PUT replaces the whole format_prefs and locks: read them fresh first, so an agent's change since the page loaded
    // (or another lock flipped in Settings) is sent back as it is now, and only this one lock changes.
    const fresh = await q.refetch();
    const cur = fresh.data?.resources.find((x) => x.ref === r.ref);
    if (!cur) { toast.error(fresh.error ? describeError(fresh.error) : 'This resource is gone. Reload the page.'); return; }
    const locks = toggleLock(cur.locks, field);
    put.mutate({ ref: cur.ref, format_prefs: cur.formatPrefs, format_locks: locks }, {
      onSuccess: () => toast.success(`${FORMAT_LABEL[field]} ${locks.includes(field) ? 'locked: agents cannot change it' : 'unlocked: agents may change it again'}`),
      onError: (e) => toast.error(errorBody(e)?.error ? errorText(e) : describeError(e)),
    });
  };

  return (
    <SectionCard title="How posts look" icon="wrench" flush delay={delay} action={<SettingsLink handle={handle}>Edit in Settings →</SettingsLink>}>
      {q.error && <div className="panel-row"><span className="text-body-sm agent-muted">Formatting is not available right now.</span></div>}
      {!d && !q.error && <div className="summary-skeleton" aria-hidden />}
      {d && !r && <div className="panel-row"><span className="text-body-sm agent-muted">This agent has no resource to format.</span></div>}
      {d && r && (
        <>
          <div className="panel-row"><span className="text-micro agent-dim">{lockSummary(d.changesPerDay, r.locks.length)}</span></div>
          {formatRows(r.formatPrefs, r.locks).map((row) => (
            <div className="panel-row fmt-row" key={row.field}>
              <div className="fmt-main">
                <span className="text-overline">{row.label}</span>
                <span className={`fmt-value clamp${row.value ? '' : ' is-unset'}`} title={row.value ?? undefined}>{row.value ?? 'Not set — the agent decides'}</span>
              </div>
              <button type="button" className="chip-toggle is-warning" aria-pressed={row.locked} disabled={put.isPending || q.isFetching}
                title={row.locked ? 'Locked: agents cannot change it. Click to unlock.' : 'Lock it so agents cannot change it'}
                onClick={() => { void flip(row.field); }}>
                <Icon name={row.locked ? 'lock' : 'unlock'} size={12} /> {row.locked ? 'Locked' : 'Lock'}
              </button>
            </div>
          ))}
        </>
      )}
      {card && channelKey && (
        <div className="panel-foot text-micro">
          <span className="agent-dim fmt-card">
            Channel card: hashtags {card.hashtagMin}–{card.hashtagMax} · links {card.linkStyle} · emoji {card.emojiPolicy}
          </span>
          <Link to="/app/editor/$channel" params={{ channel: channelKey }} className="panel-link">Edit on the card →</Link>
        </div>
      )}
    </SectionCard>
  );
}
