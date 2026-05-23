// apps/dashboard/src/components/EditChannelModal.tsx
//
// Edit Phase 5a config fields on a channel: bot binding, is_mine flag,
// poll tier, channel_key, kind. Themes are edited in a separate modal
// (EditThemesModal) because the theme vocabulary picker is dense.

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { trackingApi, PatchChannelInput } from '../api/tracking';
import { useBots } from '../api/bots';
import { Modal } from './Modal';
import type { TrackedChannel } from '../api/types';

interface Props {
  channel: TrackedChannel;
  open:    boolean;
  onClose: () => void;
}

export function EditChannelModal({ channel, open, onClose }: Props) {
  const qc        = useQueryClient();
  const { data: bots } = useBots();
  const [botId,      setBotId]      = useState<string | null>(channel.botId ?? null);
  const [isMine,     setIsMine]     = useState<boolean>(channel.isMine);
  const [pollTier,   setPollTier]   = useState<'hot' | 'warm' | 'cold'>(channel.pollTier);
  const [channelKey, setChannelKey] = useState<string>(channel.channelKey ?? '');
  const [kind,       setKind]       = useState<'public' | 'private' | ''>((channel.kind as any) ?? '');

  useEffect(() => {
    if (open) {
      setBotId(channel.botId ?? null);
      setIsMine(channel.isMine);
      setPollTier(channel.pollTier);
      setChannelKey(channel.channelKey ?? '');
      setKind((channel.kind as any) ?? '');
    }
  }, [open, channel]);

  const save = useMutation({
    mutationFn: (patch: PatchChannelInput) => trackingApi.patchChannel(channel.id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['channels'] });
      qc.invalidateQueries({ queryKey: ['channel', channel.id] });
      onClose();
    },
  });

  const submit = () => {
    save.mutate({
      botId:      botId,
      isMine,
      pollTier,
      channelKey: channelKey.trim() || null,
      kind:       kind === '' ? null : kind,
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit channel"
      subtitle={channel.title ?? channel.username ?? channel.id}
    >
      <Field label="Bot">
        <select
          value={botId ?? ''}
          onChange={e => setBotId(e.target.value || null)}
          className="input-field"
          style={{ width: '100%' }}
        >
          <option value="">— none —</option>
          {bots?.map(b => (
            <option key={b.id} value={b.id}>
              {b.bot_id}{b.username ? ` (@${b.username})` : ''}{!b.active ? ' · inactive' : ''}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Channel key" hint="@username or -100… numeric id">
        <input
          value={channelKey}
          onChange={e => setChannelKey(e.target.value)}
          placeholder="@my_channel"
          className="input-field"
          style={{ width: '100%' }}
        />
      </Field>

      <Field label="Kind">
        <div className="tabs-pill" style={{ width: 'fit-content' }}>
          {(['', 'public', 'private'] as const).map(k => (
            <button
              key={k || 'none'}
              type="button"
              onClick={() => setKind(k)}
              className={`tabs-pill-item${kind === k ? ' is-selected' : ''}`}
            >
              {k || '— none —'}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Poll tier">
        <div className="tabs-pill" style={{ width: 'fit-content' }}>
          {(['hot', 'warm', 'cold'] as const).map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setPollTier(t)}
              className={`tabs-pill-item${pollTier === t ? ' is-selected' : ''}`}
            >
              {t}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Ownership">
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={isMine}
            onChange={e => setIsMine(e.target.checked)}
            style={{ accentColor: 'var(--color-accent)' }}
          />
          <span className="text-body-sm" style={{ color: 'var(--color-ink)' }}>
            Mine — this is one of my own channels (strategies publish here)
          </span>
        </label>
      </Field>

      {save.error && (
        <p className="text-body-sm" style={{ color: 'var(--color-danger)', marginBottom: 12 }}>
          {(save.error as Error).message}
        </p>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onClose} className="btn-secondary">Cancel</button>
        <button onClick={submit} disabled={save.isPending} className="btn-primary">
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span className="text-eyebrow">{label}</span>
        {hint && <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}
