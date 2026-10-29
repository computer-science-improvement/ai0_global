// apps/dashboard/src/components/EditChannelModal.tsx
//
// Edit Phase 5a config fields on a channel: bot binding, is_mine flag,
// poll tier, channel_key, kind. Themes are edited in a separate modal
// (EditThemesModal) because the theme vocabulary picker is dense.

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { trackingApi, PatchChannelInput } from '../api/tracking';
import { useBots, useSetDefaultBot } from '../api/bots';
import { Modal } from './Modal';
import { SegmentedTabs } from './SegmentedTabs';
import { ErrorCallout } from './channels/ChannelsUi';
import { Field } from './ui/primitives';
import type { TrackedChannel } from '../api/types';

interface Props {
  channel: TrackedChannel;
  open:    boolean;
  onClose: () => void;
}

type Kind = 'public' | 'private' | '';
type Tier = 'hot' | 'warm' | 'cold';

const KIND_OPTIONS: { key: Kind; label: string }[] = [
  { key: '',        label: '— none —' },
  { key: 'public',  label: 'public' },
  { key: 'private', label: 'private' },
];
const TIER_OPTIONS: { key: Tier; label: string }[] = [
  { key: 'hot',  label: 'hot' },
  { key: 'warm', label: 'warm' },
  { key: 'cold', label: 'cold' },
];

export function EditChannelModal({ channel, open, onClose }: Props) {
  const qc        = useQueryClient();
  const { data: bots } = useBots();
  const setDefaultBot  = useSetDefaultBot();
  const [title,         setTitle]         = useState<string>(channel.title ?? '');
  const [botId,         setBotId]         = useState<string | null>(channel.botId ?? null);
  const [isMine,        setIsMine]        = useState<boolean>(channel.isMine);
  const [pollTier,      setPollTier]      = useState<Tier>(channel.pollTier);
  const [channelKey,    setChannelKey]    = useState<string>(channel.channelKey ?? '');
  const [tgChatId,      setTgChatId]      = useState<string>(channel.tgChatId ?? '');
  const [kind,          setKind]          = useState<Kind>((channel.kind as Kind | null | undefined) ?? '');
  const [publishPaused, setPublishPaused] = useState<boolean>(channel.publishPaused ?? false);

  useEffect(() => {
    if (open) {
      setTitle(channel.title ?? '');
      setBotId(channel.botId ?? null);
      setIsMine(channel.isMine);
      setPollTier(channel.pollTier);
      setChannelKey(channel.channelKey ?? '');
      setTgChatId(channel.tgChatId ?? '');
      setKind((channel.kind as Kind | null | undefined) ?? '');
      setPublishPaused(channel.publishPaused ?? false);
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
      title:         title.trim() || null,
      tgChatId:      tgChatId.trim() || null,
      publishPaused,
      botId:         botId,
      isMine,
      pollTier,
      channelKey: channelKey.trim() || null,
      kind:       kind === '' ? null : kind,
    });
  };

  const selectedBot = bots?.find(b => b.id === botId) ?? null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit channel"
      subtitle={channel.title ?? channel.username ?? channel.id}
      icon="channels"
    >
      <Field label="Name" hint="display title shown across the dashboard">
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="Channel display name"
          className="input-field"
          style={{ width: '100%' }}
        />
      </Field>

      <Field label="Bot">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select
            value={botId ?? ''}
            onChange={e => setBotId(e.target.value || null)}
            className="input-field"
            style={{ flex: '1 1 200px', minWidth: 0 }}
          >
            <option value="">— none —</option>
            {bots?.map(b => (
              <option key={b.id} value={b.id}>
                {b.bot_id}{b.username ? ` (@${b.username})` : ''}{!b.active ? ' · inactive' : ''}{b.is_default ? ' (default)' : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => { if (botId) setDefaultBot.mutate({ id: botId, default: true }); }}
            disabled={!selectedBot || selectedBot.is_default || setDefaultBot.isPending}
            className="btn-secondary"
            style={{ whiteSpace: 'nowrap' }}
            title="Make the selected bot the default fallback publisher for channels with no bot."
          >
            Set default bot
          </button>
        </div>
      </Field>

      <Field label="Channel key" hint="@username (public) or -100… numeric id (private)">
        <input
          value={channelKey}
          onChange={e => setChannelKey(e.target.value)}
          placeholder="@my_channel"
          className="input-field mono"
          style={{ width: '100%' }}
        />
      </Field>

      <Field label="Chat id" hint="numeric -100… id; required for private channels">
        <input
          value={tgChatId}
          onChange={e => setTgChatId(e.target.value)}
          placeholder="-1003984251759"
          className="input-field mono"
          style={{ width: '100%' }}
        />
      </Field>

      <Field label="Kind">
        <SegmentedTabs<Kind> value={kind} onChange={setKind} options={KIND_OPTIONS} ariaLabel="Channel kind" />
      </Field>

      <Field label="Poll tier">
        <SegmentedTabs<Tier> value={pollTier} onChange={setPollTier} options={TIER_OPTIONS} ariaLabel="Poll tier" />
      </Field>

      <Field label="Publishing">
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={publishPaused}
            onChange={e => setPublishPaused(e.target.checked)}
            className="ch-check"
          />
          <span className="text-body-sm ch-ink">
            Pause publishing — strategies & forwards into this channel are blocked at publish time
          </span>
        </label>
      </Field>

      <Field label="Ownership">
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={isMine}
            onChange={e => setIsMine(e.target.checked)}
            className="ch-check"
          />
          <span className="text-body-sm ch-ink">
            Mine — this is one of my own channels (its agent publishes here)
          </span>
        </label>
      </Field>

      {save.error && <ErrorCallout title="Couldn’t save the channel" message={(save.error as Error).message} />}

      <div className="modal-foot">
        <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
        <button type="button" onClick={submit} disabled={save.isPending} className="btn-primary">
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}
