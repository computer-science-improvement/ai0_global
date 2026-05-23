// apps/dashboard/src/components/ForwardRoutesPanel.tsx
//
// Renders + edits forward routes outgoing from a given source channel.
// Inline list with delete-on-row; "Add forward" expands to a small form
// (target picker + topic + optional description). Keeps the channel-
// detail page free of a full second modal.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { trackingApi } from '../api/tracking';
import {
  useForwardRoutes, useCreateForwardRoute, useDeleteForwardRoute,
} from '../api/forward-routes';
import { Icon } from './Icon';

interface Props { sourceChannelId: string; }

export function ForwardRoutesPanel({ sourceChannelId }: Props) {
  const { data, isLoading } = useForwardRoutes(sourceChannelId);
  const remove              = useDeleteForwardRoute(sourceChannelId);
  const [adding, setAdding] = useState(false);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div className="text-eyebrow">Forward routes outgoing</div>
        {!adding && (
          <button className="btn-tiny" onClick={() => setAdding(true)}>
            <Icon name="plus" size={12} style={{ marginRight: 4 }} />
            Add forward
          </button>
        )}
      </div>

      {adding && (
        <AddForwardForm
          sourceChannelId={sourceChannelId}
          onDone={() => setAdding(false)}
        />
      )}

      {isLoading && (
        <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>
      )}

      {data && data.length === 0 && !adding && (
        <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>
          No forwards configured. Content published here goes only to this channel.
        </p>
      )}

      {data && data.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {data.map(r => (
            <div
              key={r.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '130px 1fr 1fr 32px',
                gap: 12, alignItems: 'center',
                padding: '8px 12px',
                background: 'var(--color-surface-1)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <span className="chip" style={{ minWidth: 0, justifySelf: 'start' }}>{r.topic}</span>
              <span className="text-body-sm" style={{ color: 'var(--color-ink)' }}>
                → {r.target_title ?? r.target_channel_key ?? r.target_channel_id}
              </span>
              <span className="text-micro" style={{ color: 'var(--color-ink-muted)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.description || <em style={{ color: 'var(--color-ink-dim)' }}>no description</em>}
              </span>
              <button
                onClick={() => { if (confirm(`Delete forward "${r.topic}"?`)) remove.mutate(r.id); }}
                className="btn-icon"
                style={{ width: 28, height: 28, color: 'var(--color-ink-muted)' }}
                title="Delete forward"
              >
                <Icon name="trash" size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
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
    <div
      style={{
        padding: 12,
        background: 'var(--color-surface-2)',
        borderRadius: 'var(--radius-md)',
        marginBottom: 12,
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 10,
        alignItems: 'end',
      }}
    >
      <label>
        <div className="text-eyebrow" style={{ marginBottom: 6 }}>Target channel</div>
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
              <option key={c.id} value={c.id}>
                {c.title ?? c.username ?? c.id}
                {c.channelKey ? ` (${c.channelKey})` : ''}
              </option>
            ))}
        </select>
      </label>
      <label>
        <div className="text-eyebrow" style={{ marginBottom: 6 }}>Topic</div>
        <input
          value={topic}
          onChange={e => setTopic(e.target.value)}
          placeholder="ai_news.tech"
          className="input-field"
          style={{ width: '100%' }}
        />
      </label>
      <label style={{ gridColumn: '1 / -1' }}>
        <div className="text-eyebrow" style={{ marginBottom: 6 }}>Description (optional)</div>
        <input
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="Why does this forward exist?"
          className="input-field"
          style={{ width: '100%' }}
        />
      </label>
      {create.error && (
        <p className="text-body-sm" style={{ color: 'var(--color-danger)', margin: 0, gridColumn: '1 / -1' }}>
          {(create.error as Error).message}
        </p>
      )}
      <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <button onClick={onDone} className="btn-secondary">Cancel</button>
        <button onClick={submit} disabled={!valid || create.isPending} className="btn-primary">
          {create.isPending ? 'Saving…' : 'Add'}
        </button>
      </div>
    </div>
  );
}
