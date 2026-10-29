// apps/dashboard/src/components/ForwardRoutesPanel.tsx
//
// Renders + edits forward routes outgoing from a given source channel, as a flush panel of rows
// (topic → target, description, delete). "Add forward" opens a small form at the top of the panel
// (target picker + topic + optional description), so the channel page needs no second dialog.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { trackingApi } from '../api/tracking';
import {
  useForwardRoutes, useCreateForwardRoute, useDeleteForwardRoute,
} from '../api/forward-routes';
import { Icon } from './ui/Icon';
import { TableAction } from './ui/table';
import { SectionCard, EmptyState } from './ui/primitives';
import { LoadingNote, SectionCaption } from './channels/ChannelsUi';
import { useConfirm } from './ui/ConfirmDialog';
import { channelOptionLabel } from '../lib/labels';
import { describeError } from './ui/Toast';

interface Props {
  sourceChannelId: string;
  /** Entrance delay of the panel (ms). */
  delay?: number;
}

export function ForwardRoutesPanel({ sourceChannelId, delay }: Props) {
  const { data, isLoading, error } = useForwardRoutes(sourceChannelId);
  const remove              = useDeleteForwardRoute(sourceChannelId);
  const confirm             = useConfirm();
  const [adding, setAdding] = useState(false);

  return (
    <SectionCard
      title={<>Forward routes <SectionCaption>outgoing</SectionCaption></>}
      flush
      delay={delay}
      action={!adding && (
        <button type="button" className="btn-secondary btn-sm" onClick={() => setAdding(true)}>
          <Icon name="plus" size={14} /> Add forward
        </button>
      )}
    >
      {adding && (
        <AddForwardForm
          sourceChannelId={sourceChannelId}
          onDone={() => setAdding(false)}
        />
      )}

      {isLoading && <LoadingNote note="Loading forward routes…" />}

      {error && <EmptyState icon="warning" title="Couldn’t load forward routes" note={describeError(error)} />}

      {data && data.length === 0 && !adding && (
        <EmptyState
          icon="connections"
          title="No forwards configured"
          note="Content published here goes only to this channel."
        />
      )}

      {data && data.map(r => (
        <div key={r.id} className="panel-row">
          <span className="chip mono" title="Topic">{r.topic}</span>
          <span className="ch-fwd-target">
            → {r.target_title ?? r.target_channel_key ?? r.target_channel_id}
          </span>
          <span className={`ch-fwd-desc clamp${r.description ? '' : ' is-empty'}`}>
            {r.description || 'no description'}
          </span>
          <TableAction
            action="delete"
            title="Delete forward"
            onClick={async () => { if (await confirm(`delete forward "${r.topic}"`)) remove.mutate(r.id); }}
          />
        </div>
      ))}
    </SectionCard>
  );
}

function AddForwardForm({ sourceChannelId, onDone }: { sourceChannelId: string; onDone: () => void }) {
  const [targetId,    setTargetId]    = useState('');
  const [topic,       setTopic]       = useState('');
  const [description, setDescription] = useState('');

  const create = useCreateForwardRoute();

  // Pull all channels — both 'mine' and 'all' candidates can be targets.
  const channels = useQuery({
    queryKey: ['channels', 'forward-picker'],
    queryFn:  () => trackingApi.listChannels({ filter: 'all', pageSize: 500 }),
  });

  const submit = async () => {
    try {
      await create.mutateAsync({
        source_channel_id: sourceChannelId,
        target_channel_id: targetId,
        topic:             topic.trim(),
        description:       description.trim() || undefined,
      });
      onDone();
    } catch { /* error rendered inline */ }
  };

  const valid = targetId && topic.trim() && targetId !== sourceChannelId;

  return (
    <div className="ch-form">
      <label>
        <span className="text-eyebrow">Target channel</span>
        <select
          value={targetId}
          onChange={e => setTargetId(e.target.value)}
          className="input-field"
          style={{ width: '100%' }}
        >
          <option value="">{channels.isLoading ? 'Loading…' : 'Pick target'}</option>
          {channels.data?.items
            .filter(c => c.id !== sourceChannelId)
            .map(c => (
              <option key={c.id} value={c.id}>{channelOptionLabel(c)}</option>
            ))}
        </select>
      </label>
      <label>
        <span className="text-eyebrow">Topic</span>
        <input
          value={topic}
          onChange={e => setTopic(e.target.value)}
          placeholder="ai_news.tech"
          className="input-field mono"
          style={{ width: '100%' }}
        />
      </label>
      <label className="ch-form-wide">
        <span className="text-eyebrow">Description (optional)</span>
        <input
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="Why does this forward exist?"
          className="input-field"
          style={{ width: '100%' }}
        />
      </label>
      {create.error && <p className="ch-form-error">{describeError(create.error)}</p>}
      <div className="ch-form-actions">
        <button type="button" onClick={onDone} className="btn-ghost">Cancel</button>
        <button type="button" onClick={submit} disabled={!valid || create.isPending} className="btn-primary btn-sm">
          {create.isPending ? 'Saving…' : 'Add'}
        </button>
      </div>
    </div>
  );
}
