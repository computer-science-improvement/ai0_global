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
import { useBots } from '../api/bots';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { CHANNEL_KIND_HELP, POLL_TIER_HELP, CHANNEL_FLAG_HELP } from '../lib/labels';

type Kind = 'public' | 'private';

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
  const [pollTier,   setPollTier]   = useState<'hot' | 'warm' | 'cold'>('warm');

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

  // Public-username discovery path: keeps the legacy addChannel endpoint
  // for the simple "track this public channel" case.
  const addDiscovery = useMutation({
    mutationFn: (u: string) => trackingApi.addChannel(u),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['channels'] });
      reset(); onClose();
      navigate({ to: '/channels/$id' as any, params: { id: res.id } as any });
    },
  });

  // Full-config path — used for private channels and for any case where
  // the operator wants bot + mine + tier set upfront.
  const createFull = useMutation({
    mutationFn: (input: CreateFullChannelInput) => trackingApi.createFullChannel(input),
    onSuccess: (channel) => {
      qc.invalidateQueries({ queryKey: ['channels'] });
      reset(); onClose();
      navigate({ to: '/channels/$id' as any, params: { id: channel.id } as any });
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
    <Modal open={open} onClose={onClose} title="Add channel" size="lg">
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Kind" help={`${CHANNEL_KIND_HELP.public}\n\nvs\n\n${CHANNEL_KIND_HELP.private}`}>
          <div className="tabs-pill" style={{ width: 'fit-content' }}>
            {(['private', 'public'] as Kind[]).map(k => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={`tabs-pill-item${kind === k ? ' is-selected' : ''}`}
              >
                {k}
              </button>
            ))}
          </div>
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
              className="input-field"
              style={{ width: '100%', fontVariantNumeric: 'tabular-nums' }}
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

        <Field label="Bot" help="Telegram bot account that will publish content to this channel.">
          <select
            value={botId}
            onChange={e => setBotId(e.target.value)}
            className="input-field"
            style={{ width: '100%' }}
          >
            <option value="">— none —</option>
            {bots?.map(b => (
              <option key={b.id} value={b.id}>
                {b.bot_id}{b.username ? ` (@${b.username})` : ''}{!b.active && ' · inactive'}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Poll tier" help={`hot: ${POLL_TIER_HELP.hot}\n\nwarm: ${POLL_TIER_HELP.warm}\n\ncold: ${POLL_TIER_HELP.cold}`}>
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

        <Field label="Ownership" help={`mine: ${CHANNEL_FLAG_HELP.mine}`}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'not-allowed', opacity: 0.85 }}>
            <input
              type="checkbox"
              checked={forcedMine}
              disabled
              readOnly
              style={{ accentColor: 'var(--color-accent)' }}
            />
            <span className="text-body-sm" style={{ color: 'var(--color-ink)' }}>
              {forcedMine
                ? 'Mine — strategies can publish into this channel'
                : 'External — tracked only; strategies will not publish here'}
            </span>
          </label>
        </Field>

        {error && (
          <p className="text-body-sm" style={{ color: 'var(--color-danger)', margin: 0 }}>
            {error.message}
          </p>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={!valid || pending} className="btn-primary">
            {pending ? 'Adding…' : (
              <>
                <Icon name="plus" size={14} style={{ marginRight: 4 }} />
                Add
              </>
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Field({ label, hint, help, children }: { label: string; hint?: string; help?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block' }} title={help}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span className="text-eyebrow">{label}</span>
        {help && <Icon name="info" size={11} style={{ color: 'var(--color-ink-dim)', verticalAlign: 'middle' }} />}
        {hint && <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{hint}</span>}
      </div>
      {children}
    </label>
  );
}
