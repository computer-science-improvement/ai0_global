import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState, Field } from '../components/ui/primitives';
import { Icon } from '../components/ui/Icon';
import { Modal } from '../components/Modal';
import { describeError, toast } from '../components/ui/Toast';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { SteeringCard, steeringError } from '../components/steering/SteeringCard';
import { useEditorChannels } from '../api/editor';
import { useCreateSteering, useSteeringEstimate, useSteeringSets } from '../api/steering';
import { fmtUsd } from '../lib/channel-setup';
import { isClosed } from '../lib/steering';

// Steering (spec 045 FR-008): a reference channel that is not ours becomes lowest-priority rules for one of our
// channels. One compact card per set; ?set=<id> opens it, ?target=@key filters by our channel.
type View = 'open' | 'closed';

export const Route = createFileRoute('/app/steering')({
  validateSearch: (s: Record<string, unknown>): { set?: string; target?: string; view?: View } => ({
    set: typeof s.set === 'string' && s.set ? s.set : undefined,
    target: typeof s.target === 'string' && s.target ? s.target : undefined,
    view: s.view === 'closed' ? 'closed' : undefined,
  }),
  component: SteeringPage,
});

function SteeringPage() {
  const { set: focus, target, view = 'open' } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const q = useSteeringSets(target ?? null);
  const [creating, setCreating] = useState(false);

  const sets = q.data?.sets ?? [];
  const open = sets.filter((s) => !isClosed(s.status));
  const closed = sets.filter((s) => isClosed(s.status));
  // A deep link to a closed set shows the closed tab.
  const focusClosed = !!focus && closed.some((s) => s.id === focus);
  const shown = (view === 'closed' || focusClosed) ? closed : open;
  const targets = useMemo(() => [...new Set(sets.map((s) => s.targetRef))], [sets]);

  const setView = (v: View) => navigate({ search: (s) => ({ ...s, view: v === 'open' ? undefined : v, set: undefined }), replace: true });

  return (
    <div>
      <PageHeader
        title="Steering"
        subtitle="Point at a channel you like that is not yours. The agent reads its last 20 posts and writes rules for one of your channels: the form and the direction of the content, never its text or facts. Your channel's own rules always win."
        actions={(
          <button className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} /> New steering
          </button>
        )}
      />

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <SegmentedTabs value={focusClosed ? 'closed' : view} onChange={setView} options={[
          { key: 'open', label: `In use and in review (${open.length})` },
          { key: 'closed', label: `Closed (${closed.length})` },
        ]} />
        {target && (
          <button type="button" className="btn-tiny" onClick={() => navigate({ search: (s) => ({ ...s, target: undefined }) })}>
            {target} <Icon name="x" size={12} />
          </button>
        )}
        {!target && targets.length > 1 && (
          <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>{targets.length} channels steered</span>
        )}
      </div>

      {q.error && <div className="callout-danger" style={{ marginBottom: 12 }}>{describeError(q.error)}</div>}
      {!q.data && !q.error && <div className="panel compose-rise" style={{ height: 160, opacity: 0.55 }} />}
      {q.data && shown.length === 0 && (
        <EmptyState icon="compass" title={view === 'closed' ? 'Nothing closed yet' : 'No steering yet'}
          note={view === 'closed' ? 'Discarded, replaced and failed analyses show here.'
            : 'Pick one of your channels and a public Telegram channel to learn from. You review the rules before the agent gets them.'}
          action={view === 'closed' ? undefined : <button className="btn-primary" onClick={() => setCreating(true)}>New steering</button>} />
      )}
      {shown.length > 0 && (
        <div className="compact-grid">
          {shown.map((s, i) => <SteeringCard key={s.id} s={s} focused={s.id === focus} delay={Math.min(i, 10) * 30} />)}
        </div>
      )}

      {creating && (
        <NewSteeringDialog initialTarget={target ?? null} onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); navigate({ search: (s) => ({ ...s, view: undefined, set: id }) }); }} />
      )}
    </div>
  );
}

function NewSteeringDialog({ initialTarget, onClose, onCreated }: { initialTarget: string | null; onClose: () => void; onCreated: (id: string) => void }) {
  const channels = useEditorChannels();
  const est = useSteeringEstimate();
  const create = useCreateSteering();
  const options = (channels.data?.channels ?? []).filter((c) => c.channelKey.startsWith('@'));
  const [target, setTarget] = useState(initialTarget ?? '');
  const [source, setSource] = useState('');
  const [error, setError] = useState<string | null>(null);
  const chosen = target || options[0]?.channelKey || '';
  const ok = !!chosen && source.trim().length >= 2;
  const cost = est.data?.estimateUsd;

  const submit = () => create.mutate({ target: chosen, source: source.trim() }, {
    onSuccess: (r) => { toast.success('Queued. The rules show here in about a minute.'); onCreated(r.set.id); },
    onError: (e) => setError(steeringError(e)),
  });

  return (
    <Modal open onClose={onClose} title="New steering" subtitle="Learn the form and the direction from a channel you like" icon="compass">
      <Field label="Your channel" hint="It follows the rules once you activate them">
        <select className="input-field" style={{ width: '100%' }} value={chosen} onChange={(e) => { setTarget(e.target.value); setError(null); }}
          disabled={!options.length}>
          {!options.length && <option value="">{channels.isLoading ? 'Loading…' : 'No channels with an editor card'}</option>}
          {options.map((c) => <option key={c.channelKey} value={c.channelKey}>{c.title ? `${c.title} (${c.channelKey})` : c.channelKey}</option>)}
        </select>
      </Field>
      <Field label="Reference" hint="A public Telegram channel: @username or a t.me link">
        <input className="input-field" style={{ width: '100%', boxSizing: 'border-box' }} value={source} placeholder="@channel or https://t.me/channel"
          autoCapitalize="none" spellCheck={false} onChange={(e) => { setSource(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && ok && !create.isPending) submit(); }} />
      </Field>
      <div className="text-micro" style={{ color: 'var(--color-ink-muted)', marginBottom: 12 }}>
        One model run{cost != null ? `, about ${fmtUsd(cost)} from past runs` : ' (the cost estimate comes from past runs)'}. Nothing changes until you review the rules and activate them.
      </div>
      {error && <div className="callout-danger" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="modal-foot">
        <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!ok || create.isPending} onClick={submit}>Analyze</button>
      </div>
    </Modal>
  );
}
