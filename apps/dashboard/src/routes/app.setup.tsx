import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState } from '../components/ui/primitives';
import { Badge } from '../components/ui/Badge';
import { Icon } from '../components/ui/Icon';
import { ActionsTh, RowActions, TableAction } from '../components/ui/table';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { describeError, toast } from '../components/ui/Toast';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { SetupProposalDialog } from '../components/setup/SetupProposalDialog';
import { useAnalyzeChannels, useSetupOverview, type SetupOverviewRow } from '../api/channel-setup';
import { estimateText, fmtUsd, isReviewable, isRunning, missingSetup, SETUP_STATUS } from '../lib/channel-setup';

// Channel setup from history (spec 042 FR-008): own channels with what their agent has (card, brief, profile,
// playbook), the latest proposal, and a batch "Analyze selected". A proposal opens in a dialog (?proposal=<id>).
type Filter = 'all' | 'missing';

export const Route = createFileRoute('/app/setup')({
  validateSearch: (s: Record<string, unknown>): { proposal?: string; filter?: Filter } => ({
    proposal: typeof s.proposal === 'string' && s.proposal ? s.proposal : undefined,
    filter: s.filter === 'missing' ? 'missing' : undefined,
  }),
  component: SetupPage,
});

function SetupPage() {
  const { proposal, filter = 'all' } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const q = useSetupOverview();
  const analyze = useAnalyzeChannels();
  const confirm = useConfirm();
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const rows = useMemo(() => {
    const all = q.data?.channels ?? [];
    return filter === 'missing' ? all.filter((r) => missingSetup(r).length > 0) : all;
  }, [q.data, filter]);
  const missingCount = (q.data?.channels ?? []).filter((r) => missingSetup(r).length > 0).length;
  const selectable = rows.filter((r) => !isRunning(r.latest?.status));
  const chosen = selectable.filter((r) => picked.has(r.channelKey)).map((r) => r.channelKey);
  const allPicked = selectable.length > 0 && chosen.length === selectable.length;

  const setFilter = (f: Filter) => navigate({ search: (s) => ({ ...s, filter: f === 'all' ? undefined : f }), replace: true });
  const open = (id: string) => navigate({ search: (s) => ({ ...s, proposal: id }) });
  const close = () => navigate({ search: (s) => ({ ...s, proposal: undefined }) });
  const toggle = (key: string) => setPicked((cur) => {
    const n = new Set(cur);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  const run = async (keys: string[]) => {
    if (!keys.length) return;
    const replacing = keys.filter((k) => isReviewable(q.data?.channels.find((c) => c.channelKey === k)?.latest?.status)).length;
    const note = replacing ? `; ${replacing} open proposal${replacing === 1 ? '' : 's'} will be replaced` : '';
    if (!(await confirm(`analyze the last 20 posts of ${estimateText(q.data?.estimateUsd ?? null, keys.length)}${note}`, { danger: false, confirmLabel: 'Analyze' }))) return;
    analyze.mutate(keys, {
      onSuccess: (r) => {
        setPicked(new Set());
        if (r.queued.length) toast.success(`Queued ${r.queued.length} channel${r.queued.length === 1 ? '' : 's'}. Each takes about a minute.`);
        if (r.refused.length) toast.error(`Not queued: ${r.refused.map((x) => `${x.channelKey} (${x.error === 'not_own_channel' ? 'not your channel' : x.error})`).join(', ')}`);
      },
      onError: (e) => toast.error(describeError(e)),
    });
  };

  return (
    <div>
      <PageHeader
        title="Setup from history"
        subtitle="The agent reads a channel's last 20 posts and proposes its brief, profile, formatting, format mix, series, schedule and voice. Nothing changes until you apply a section."
        actions={(
          <button className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            disabled={!chosen.length || analyze.isPending} onClick={() => run(chosen)}>
            <Icon name="sparkles" size={14} /> Analyze selected{chosen.length ? ` (${chosen.length})` : ''}
          </button>
        )}
      />

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <SegmentedTabs value={filter} onChange={setFilter} options={[
          { key: 'all', label: `All channels${q.data ? ` (${q.data.channels.length})` : ''}` },
          { key: 'missing', label: `Missing setup (${missingCount})` },
        ]} />
        <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>
          {q.data?.estimateUsd != null ? `About ${fmtUsd(q.data.estimateUsd)} per channel, from past runs.` : 'The cost per channel shows after the first run.'}
        </span>
      </div>

      {q.error && <div className="callout-danger" style={{ marginBottom: 12 }}>{describeError(q.error)}</div>}
      {!q.data && !q.error && <div className="panel compose-rise" style={{ height: 160, opacity: 0.55 }} />}
      {q.data && rows.length === 0 && (
        <EmptyState icon="channels" title={filter === 'missing' ? 'Every channel is set up' : 'No own channels yet'}
          note={filter === 'missing' ? 'Each own channel has a card, a brief, a profile and a playbook.'
            : <>Add your channels on <Link to="/app/channels" search={{ filter: 'mine', page: 1, q: '' }} className="link-accent">My channels</Link>; their posts are read by the tracking account.</>} />
      )}

      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr>
              <th style={{ width: 36 }}>
                <input type="checkbox" aria-label="Select all channels" checked={allPicked} disabled={!selectable.length}
                  onChange={() => setPicked(allPicked ? new Set() : new Set(selectable.map((r) => r.channelKey)))}
                  style={{ accentColor: 'var(--color-accent)' }} />
              </th>
              <th>Channel</th>
              <th>Agent setup</th>
              <th className="num">Posts</th>
              <th>Latest analysis</th>
              <ActionsTh />
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <SetupRow key={r.channelKey} r={r} picked={picked.has(r.channelKey)} onPick={() => toggle(r.channelKey)}
                  onOpen={open} onAnalyze={() => run([r.channelKey])} busy={analyze.isPending} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SetupProposalDialog id={proposal ?? null} onClose={close} />
    </div>
  );
}

function SetupRow({ r, picked, onPick, onOpen, onAnalyze, busy }: {
  r: SetupOverviewRow; picked: boolean; onPick: () => void; onOpen: (id: string) => void; onAnalyze: () => void; busy: boolean;
}) {
  const l = r.latest;
  const st = l ? SETUP_STATUS[l.status] : null;
  const running = isRunning(l?.status);
  const missing = missingSetup(r);
  const have = (ok: boolean, label: string) => <Badge tone={ok ? 'success' : 'neutral'} title={ok ? `${label} is set` : `No ${label.toLowerCase()} yet`}>{ok ? label : `no ${label.toLowerCase()}`}</Badge>;
  return (
    <tr>
      <td><input type="checkbox" aria-label={`Select ${r.channelKey}`} checked={picked} disabled={running} onChange={onPick} style={{ accentColor: 'var(--color-accent)' }} /></td>
      <td>
        <div style={{ fontWeight: 500, color: 'var(--color-ink)' }}>{r.title ?? r.channelKey}</div>
        <div className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>
          {r.channelKey}
          {r.agentHandle && <> · <Link to="/app/agents/$handle" params={{ handle: r.agentHandle }} className="link-accent">@{r.agentHandle}</Link></>}
          {r.mode && <> · {r.mode}</>}
        </div>
      </td>
      <td>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }} title={missing.length ? `Missing: ${missing.join(', ')}` : 'Fully set up'}>
          {have(r.hasCard, 'Card')}{have(r.hasBrief, 'Brief')}{have(r.hasProfile, 'Profile')}{have(r.hasPlaybook, 'Playbook')}
        </div>
      </td>
      <td className="num">{r.postsStored}</td>
      <td>
        {st ? (
          <div style={{ display: 'grid', gap: 2 }}>
            <span><Badge tone={st.tone} title={l?.reason ?? st.hint}>{st.label}</Badge></span>
            <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{new Date(l!.createdAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}</span>
          </div>
        ) : <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>Never</span>}
      </td>
      <td style={{ textAlign: 'right' }}>
        <RowActions>
          {l && !['superseded'].includes(l.status) && (
            <TableAction icon="eye" title={isReviewable(l.status) ? 'Review the proposal' : 'Open the proposal'} onClick={() => onOpen(l.id)} />
          )}
          <TableAction icon="sparkles" title={l ? 'Analyze again' : 'Analyze the last 20 posts'} disabled={running || busy} onClick={onAnalyze} />
        </RowActions>
      </td>
    </tr>
  );
}
