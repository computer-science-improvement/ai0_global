// apps/dashboard/src/components/AddChannelModal.tsx
//
// Two modes:
//  • public  — operator types @username; backend triggers a discovery poll
//              that fills in title / about / subs.
//  • private — operator types numeric chat id + optional title + bot binding;
//              channel is created with the supplied config exactly.
//
// Both flows let the operator pre-set isMine, poll tier, and bot — so a
// channel arrives configured and ready, not in a half-initialised state
// the operator has to fix afterwards.

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { trackingApi, CreateFullChannelInput } from '../api/tracking';
import { useBots, useSetDefaultBot } from '../api/bots';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { SegmentedTabs } from './SegmentedTabs';
import { ErrorCallout } from './channels/ChannelsUi';
import { Badge } from './ui/Badge';
import { Field } from './ui/primitives';
import { CHANNEL_KIND_HELP, POLL_TIER_HELP, CHANNEL_FLAG_HELP } from '../lib/labels';

type Kind = 'public' | 'private';
type Tier = 'hot' | 'warm' | 'cold';

const KIND_OPTIONS: { key: Kind; label: string }[] = [
  { key: 'private', label: 'private' },
  { key: 'public',  label: 'public' },
];
const TIER_OPTIONS: { key: Tier; label: string }[] = [
  { key: 'hot',  label: 'hot' },
  { key: 'warm', label: 'warm' },
  { key: 'cold', label: 'cold' },
];

export function AddChannelModal({ open, onClose, ownership = 'mine' }: {
  open: boolean;
  onClose: () => void;
  /** Fixed by the opening page: «My channels» → mine, «Tracked» → external.
   *  The Ownership toggle is locked to this value. */
  ownership?: 'mine' | 'external';
}) {
  const forcedMine = ownership === 'mine';
  const [kind,       setKind]       = useState<Kind>(forcedMine ? 'private' : 'public');
  const [username,   setUsername]   = useState('');
  const [chatId,     setChatId]     = useState('');
  const [title,      setTitle]      = useState('');
  const [botId,      setBotId]      = useState<string>('');
  const [pollTier,   setPollTier]   = useState<Tier>('warm');

  // Re-sync sensible defaults whenever the modal (re)opens. External tracking
  // is almost always a public @username, so default kind follows ownership.
  useEffect(() => {
    if (open) {
      setKind(forcedMine ? 'private' : 'public');
      setUsername(''); setChatId(''); setTitle(''); setBotId(''); setPollTier('warm');
    }
  }, [open, forcedMine]);

  const qc           = useQueryClient();
  const navigate     = useNavigate();
  const { data: bots } = useBots();
  const setDefaultBot  = useSetDefaultBot();
  const selectedBot    = bots?.find(b => b.id === botId) ?? null;

  // Public-username discovery path: keeps the legacy addChannel endpoint
  // for the simple "track this public channel" case.
  const addDiscovery = useMutation({
    mutationFn: (u: string) => trackingApi.addChannel(u),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['channels'] });
      reset(); onClose();
      navigate({ to: '/app/channels/$id', params: { id: res.id } });
    },
  });

  // Full-config path — used for private channels and for any case where
  // the operator wants bot + mine + tier set upfront.
  const createFull = useMutation({
    mutationFn: (input: CreateFullChannelInput) => trackingApi.createFullChannel(input),
    onSuccess: (channel) => {
      qc.invalidateQueries({ queryKey: ['channels'] });
      reset(); onClose();
      navigate({ to: '/app/channels/$id', params: { id: channel.id } });
    },
  });

  const reset = () => {
    setKind(forcedMine ? 'private' : 'public'); setUsername(''); setChatId(''); setTitle('');
    setBotId(''); setPollTier('warm');
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();

    // Simple public-discovery path: only username given, no extra config,
    // and isMine left at default. This is the fastest way to start tracking
    // a public channel without manually filling everything.
    if (kind === 'public' && username.trim() && !title.trim() && !botId && pollTier === 'warm' && forcedMine) {
      addDiscovery.mutate(username.trim().replace(/^@/, ''));
      return;
    }

    createFull.mutate({
      kind,
      username:  kind === 'public' ? username.trim().replace(/^@/, '') || undefined : undefined,
      tgChatId:  kind === 'private' ? chatId.trim() : undefined,
      title:     title.trim() || undefined,
      botId:     botId || undefined,
      isMine:    forcedMine,
      pollTier,
    });
  };

  const pending = addDiscovery.isPending || createFull.isPending;
  const error   = (addDiscovery.error ?? createFull.error) as Error | null;
  const valid   = kind === 'public'
    ? username.trim().length > 0
    : chatId.trim().startsWith('-');

  return (
    <Modal open={open} onClose={onClose} title="Add channel" icon="channels" size="lg">
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Kind" hint={`${CHANNEL_KIND_HELP.public} vs ${CHANNEL_KIND_HELP.private}`}>
          <SegmentedTabs<Kind> value={kind} onChange={setKind} options={KIND_OPTIONS} ariaLabel="Channel kind" />
        </Field>

        {kind === 'public' ? (
          <Field label="Username" hint="@durov or durov — backend will poll for title + subs">
            <input
              autoFocus
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="@motivation_local"
              className="input-field"
              style={{ width: '100%' }}
            />
          </Field>
        ) : (
          <Field label="Chat id" hint="numeric -100… id from Telegram (required for private)">
            <input
              autoFocus
              value={chatId}
              onChange={e => setChatId(e.target.value)}
              placeholder="-1003984251759"
              className="input-field mono"
              style={{ width: '100%' }}
            />
          </Field>
        )}

        <Field label="Name" hint="display title. Auto-fetched on poll for public; manual for private">
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder={kind === 'private' ? 'Motivation | LOCAL' : 'optional — overrides poller'}
            className="input-field"
            style={{ width: '100%' }}
          />
        </Field>

        <Field label="Bot" hint="Telegram bot account that will publish content to this channel. If none is chosen, the default bot is used as a fallback.">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <select
              value={botId}
              onChange={e => setBotId(e.target.value)}
              className="input-field"
              style={{ flex: '1 1 200px', minWidth: 0 }}
            >
              <option value="">— none —</option>
              {bots?.map(b => (
                <option key={b.id} value={b.id}>
                  {b.bot_id}{b.username ? ` (@${b.username})` : ''}{!b.active && ' · inactive'}{b.is_default && ' (default)'}
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

        <Field label="Poll tier" hint={`hot: ${POLL_TIER_HELP.hot} · warm: ${POLL_TIER_HELP.warm} · cold: ${POLL_TIER_HELP.cold}`}>
          <SegmentedTabs<Tier> value={pollTier} onChange={setPollTier} options={TIER_OPTIONS} ariaLabel="Poll tier" />
        </Field>

        <Field label="Ownership" hint={`mine: ${CHANNEL_FLAG_HELP.mine}`}>
          {/* Fixed by the page that opened the dialog, so it is read-only. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Badge tone={forcedMine ? 'success' : 'neutral'}>{forcedMine ? 'mine' : 'external'}</Badge>
            <span className="text-body-sm ch-muted">
              {forcedMine
                ? 'Strategies can publish into this channel'
                : 'Tracked only; strategies will not publish here'}
            </span>
          </div>
        </Field>

        {error && <ErrorCallout title="Couldn’t add the channel" message={error.message} style={{ marginBottom: 0 }} />}

        <div className="modal-foot">
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" disabled={!valid || pending} className="btn-primary">
            {pending ? 'Adding…' : (
              <>
                <Icon name="plus" size={14} />
                Add
              </>
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}
