// apps/dashboard/src/components/AddStrategyModal.tsx
//
// Compact create form for a strategy_binding. Channel is picked from the
// "Mine" set (only own channels can host strategies). Schedule is a free
// cron expression — server validates via the same `cron` lib the scheduler
// uses, so an accepted schedule is guaranteed to fire. `params` left for a
// later iteration; default `{}`.

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { trackingApi } from '../api/tracking';
import { useCreateStrategy, useStrategyTypes } from '../api/strategies';
import { useMetaAccounts } from '../api/meta-accounts';
import { useTikTokAccounts } from '../api/tiktok-accounts';
import { strategyTypesForPlatform } from '../lib/strategy-types';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { STRATEGY_DESCRIPTIONS, describeStrategy, SOURCE_KIND_LABEL, channelOptionLabel } from '../lib/labels';
import { SchedulePicker } from './SchedulePicker';

interface Props { open: boolean; onClose: () => void; }

export function AddStrategyModal({ open, onClose }: Props) {
  const [extId,     setExtId]     = useState('');
  const [type,      setType]      = useState('');
  const [channelId, setChannelId] = useState('');
  const [schedule,  setSchedule]  = useState('0 9 * * *');
  const [destKind,  setDestKind]  = useState<'telegram' | 'meta' | 'tiktok'>('telegram');
  const [metaId,    setMetaId]    = useState('');
  const [tiktokId,  setTiktokId]  = useState('');

  const create = useCreateStrategy();

  // Mine-only channels — strategies publish, so they must be own channels.
  const channelsQ = useQuery({
    queryKey: ['channels', 'mine-picker'],
    queryFn:  () => trackingApi.listChannels({ filter: 'mine', pageSize: 200 }),
    enabled:  open,
  });

  // Meta accounts — only surfaced when the Meta destination is chosen.
  const metaAccountsQ = useMetaAccounts();
  const metaAccounts = open && destKind === 'meta' ? metaAccountsQ : { data: undefined, isLoading: false };

  // TikTok accounts — only surfaced when the TikTok destination is chosen.
  const tiktokQ = useTikTokAccounts();
  const tiktokAccts = open && destKind === 'tiktok' ? tiktokQ : { data: undefined, isLoading: false };

  // Registered strategy types + their supported platforms (for the Type filter).
  const typesQ = useStrategyTypes();

  // Resolved publish platform: telegram/tiktok are fixed; meta is the chosen
  // account's platform (null until one is picked).
  const platform: string | null =
    destKind === 'telegram' ? 'telegram'
    : destKind === 'tiktok'  ? 'tiktok'
    : metaPlatformOf(metaAccountsQ.data, metaId) ?? null;
  const availableTypes = strategyTypesForPlatform(typesQ.data, platform);

  // Drop a chosen Type when the destination's platform no longer supports it.
  useEffect(() => {
    if (type && !availableTypes.some(t => t.type === type)) setType('');
  }, [platform]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    try {
      await create.mutateAsync({
        ext_id:   extId.trim(),
        type:     type.trim(),
        schedule: schedule.trim(),
        enabled:  false, // new strategies start paused — enable explicitly when ready to publish
        params:   {},
        ...(destKind === 'telegram'
          ? { channel_id: channelId, platform: 'telegram' as const }
          : destKind === 'tiktok'
          ? { platform: 'tiktok' as const, tiktok_account_id: tiktokId }
          : { platform: metaPlatformOf(metaAccountsQ.data, metaId) ?? 'instagram', meta_account_id: metaId }),
      });
      setExtId(''); setType(''); setChannelId(''); setSchedule('0 9 * * *');
      setDestKind('telegram'); setMetaId(''); setTiktokId('');
      onClose();
    } catch { /* error rendered below */ }
  };

  const destId = destKind === 'telegram' ? channelId : destKind === 'tiktok' ? tiktokId : metaId;
  const valid = !!extId && !!schedule && !!destId &&
    !!type && availableTypes.some(t => t.type === type);

  return (
    <Modal open={open} onClose={onClose} title="Add strategy" size="lg">
      <Field label="Strategy id (logical name)" hint="alphanumeric + - + _">
        <input
          value={extId}
          onChange={e => setExtId(e.target.value)}
          placeholder="motivation-quote-daily"
          className="input-field"
          style={{ width: '100%' }}
        />
      </Field>

      <Field label="Destination">
        <select
          value={destKind}
          onChange={e => setDestKind(e.target.value as 'telegram' | 'meta' | 'tiktok')}
          className="input-field"
          style={{ width: '100%' }}
        >
          <option value="telegram">Telegram channel</option>
          <option value="meta">Meta account (Instagram / Facebook / Threads)</option>
          <option value="tiktok">TikTok account</option>
        </select>
      </Field>

      {destKind === 'telegram' && (
        <Field label="Channel">
          <select
            value={channelId}
            onChange={e => setChannelId(e.target.value)}
            className="input-field"
            style={{ width: '100%' }}
          >
            <option value="" disabled>
              {channelsQ.isLoading ? 'Loading…' : 'Pick a channel'}
            </option>
            {channelsQ.data?.items.map(c => (
              <option key={c.id} value={c.id}>{channelOptionLabel(c)}</option>
            ))}
          </select>
        </Field>
      )}

      {destKind === 'meta' && (
        <Field label="Meta account" hint="verified accounts only">
          <select
            value={metaId}
            onChange={e => setMetaId(e.target.value)}
            className="input-field"
            style={{ width: '100%' }}
          >
            <option value="" disabled>
              {metaAccounts.isLoading ? 'Loading…' : 'Pick a Meta account'}
            </option>
            {metaAccountsQ.data?.filter(a => a.active).map(a => (
              <option key={a.id} value={a.id}>{a.platform} — {a.username ?? a.id}</option>
            ))}
          </select>
        </Field>
      )}

      {destKind === 'tiktok' && (
        <Field label="TikTok account" hint="connected accounts only">
          <select
            value={tiktokId}
            onChange={e => setTiktokId(e.target.value)}
            className="input-field"
            style={{ width: '100%' }}
          >
            <option value="" disabled>
              {tiktokAccts.isLoading ? 'Loading…' : 'Pick a TikTok account'}
            </option>
            {tiktokQ.data?.filter(a => a.active).map(a => (
              <option key={a.id} value={a.id}>{a.username ?? a.id}</option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Type" hint={platform ? 'strategies available for this destination' : 'pick a destination first'}>
        <select
          value={type}
          onChange={e => setType(e.target.value)}
          className="input-field"
          style={{ width: '100%' }}
          disabled={!platform || availableTypes.length === 0}
        >
          <option value="" disabled>
            {!platform ? 'Pick a destination first'
              : availableTypes.length === 0 ? 'No strategies for this destination'
              : 'Pick a strategy type'}
          </option>
          {availableTypes.map(t => (
            <option key={t.type} value={t.type}>
              {(STRATEGY_DESCRIPTIONS as Record<string, { title: string }>)[t.type]?.title ?? t.type} ({t.type})
            </option>
          ))}
        </select>
        <TypeDescription type={type} />
      </Field>

      <Field label="Schedule (cron)">
        <SchedulePicker value={schedule} onChange={setSchedule} placeholder="0 9 * * *" inputId="add-strategy-schedule" />
      </Field>

      <div className="callout-warning" style={{ marginBottom: 16 }}>
        <Icon name="info" size={14} />
        <span className="text-micro">
          Restart automation after creating — scheduler picks up new strategies on boot.
        </span>
      </div>

      {create.error && (
        <p className="text-body-sm" style={{ color: 'var(--color-danger)', marginBottom: 12 }}>
          {(create.error as Error).message}
        </p>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onClose} className="btn-secondary">Cancel</button>
        <button onClick={submit} disabled={!valid || create.isPending} className="btn-primary">
          {create.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}

function metaPlatformOf(
  accounts: Array<{ id: string; platform: string }> | undefined,
  id: string,
): 'instagram' | 'facebook' | 'threads' | undefined {
  const p = accounts?.find(a => a.id === id)?.platform;
  return p === 'instagram' || p === 'facebook' || p === 'threads' ? p : undefined;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span className="text-eyebrow">{label}</span>
        {hint && <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{hint}</span>}
      </div>
      {children}
    </label>
  );
}

/** Inline description of the chosen strategy type. Helps the operator
 *  understand what this strategy does + which data source it draws from
 *  before saving. Renders only when the type matches a known slug. */
function TypeDescription({ type }: { type: string }) {
  const meta = describeStrategy(type.trim());
  if (!meta) return null;
  return (
    <div
      style={{
        marginTop: 8,
        padding: '10px 12px',
        background: 'var(--color-surface-1)',
        borderRadius: 'var(--radius-md)',
        borderLeft: '2px solid var(--color-accent)',
      }}
    >
      <div className="text-body-sm" style={{ color: 'var(--color-ink)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="sparkle" size={12} />
        {meta.title}
        <span className="chip" style={{ fontSize: 10 }}>{SOURCE_KIND_LABEL[meta.source]}</span>
      </div>
      <p className="text-micro" style={{ color: 'var(--color-ink-muted)', margin: '6px 0 0', lineHeight: 1.5 }}>
        {meta.description}
      </p>
    </div>
  );
}
