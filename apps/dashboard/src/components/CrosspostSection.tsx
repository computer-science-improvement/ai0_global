// Cross-post management for one channel — on the channel detail page (moved from the removed strategy page, spec 023 phase B).
// A flush panel: one row per Meta cross-post target (toggle / remove), and a footer to add one.
// Cross-posting fires after the channel's Telegram posts.

import { useState } from 'react';
import { Icon, type IconName } from './ui/Icon';
import { Badge } from './ui/Badge';
import { SectionCard, EmptyState } from './ui/primitives';
import { TableAction } from './ui/table';
import { SectionCaption } from './channels/ChannelsUi';
import { useConfirm } from './ui/ConfirmDialog';
import { useMetaAccounts } from '../api/meta-accounts';
import {
  useCrossposts, useCreateCrosspost, useToggleCrosspost, useDeleteCrosspost,
} from '../api/crossposts';
import type { MetaPlatform, CrosspostMode } from '../api/types';
import { describeError } from './ui/Toast';

/** Spec 024 FR-011: the stored value stays `mirror`; the UI says "duplicate". */
const CROSSPOST_MODE_LABEL: Record<string, string> = { 'mirror': 'duplicate', 'teaser': 'teaser' };

const PLATFORMS: ReadonlyArray<{ key: MetaPlatform; label: string; icon: IconName }> = [
  { key: 'facebook',  label: 'Facebook',  icon: 'facebook' },
  { key: 'instagram', label: 'Instagram', icon: 'instagram' },
  { key: 'threads',   label: 'Threads',   icon: 'threads' },
];

export function CrosspostSection({ channelId, delay }: {
  channelId: string;
  /** Entrance delay of the panel (ms). */
  delay?: number;
}) {
  const confirm  = useConfirm();
  const accounts = useMetaAccounts();
  const targets  = useCrossposts(channelId);
  const create   = useCreateCrosspost(channelId);
  const toggle   = useToggleCrosspost(channelId);
  const remove   = useDeleteCrosspost(channelId);

  const [platform, setPlatform] = useState<MetaPlatform>('facebook');
  const [accountId, setAccountId] = useState('');
  const [mode, setMode] = useState<CrosspostMode>('mirror');

  // Verified accounts for the chosen platform (must be active + have a handle).
  const platformAccounts = (accounts.data ?? []).filter(
    a => a.platform === platform && a.active && !a.verify_error,
  );
  const igForcesDuplicate = platform === 'instagram';
  const effMode: CrosspostMode = igForcesDuplicate ? 'mirror' : mode;

  const accountLabel = (id: string) => {
    const a = accounts.data?.find(x => x.id === id);
    return a ? (a.username ? `@${a.username}` : a.display_name ?? a.account_id) : id.slice(0, 8);
  };

  const add = async () => {
    if (!accountId) return;
    try {
      await create.mutateAsync({ platform, metaAccountId: accountId, mode: effMode });
      setAccountId('');
    } catch { /* error shown below */ }
  };

  return (
    <SectionCard
      title={<>Cross-posts <SectionCaption>Meta copies of this channel&apos;s posts</SectionCaption></>}
      flush
      delay={delay}
    >
      <p className="ch-note">
        After each Telegram post, this channel reposts to the selected Meta accounts.
        <b> duplicate</b> — the same content; <b>teaser</b> — a short teaser + link to the post.
      </p>

      {/* Existing targets */}
      {(targets.data ?? []).map(t => {
        const meta = PLATFORMS.find(p => p.key === t.platform) ?? PLATFORMS[0];
        return (
          <div key={t.id} className="panel-row">
            <Icon name={meta.icon} size={16} />
            <span className="ch-xp-name">{accountLabel(t.meta_account_id)}</span>
            <Badge tone="neutral">{CROSSPOST_MODE_LABEL[t.mode] ?? t.mode}</Badge>
            {!t.enabled && <Badge tone="warning">disabled</Badge>}
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <button type="button" className="btn-tiny" onClick={() => toggle.mutate({ id: t.id, enabled: !t.enabled })}>
                {t.enabled ? 'Disable' : 'Enable'}
              </button>
              <TableAction
                action="delete"
                title="Delete cross-post target"
                onClick={async () => {
                  if (await confirm(`remove cross-posting ${meta.label} → ${accountLabel(t.meta_account_id)}`)) remove.mutate(t.id);
                }}
              />
            </span>
          </div>
        );
      })}
      {targets.data && targets.data.length === 0 && (
        <EmptyState icon="connections" title="No cross-posting targets yet" note="Pick a platform and an account below to add one." />
      )}

      {/* Add a target */}
      <div className="panel-foot">
        <select className="input-field ch-select" aria-label="Platform"
          value={platform} onChange={e => { setPlatform(e.target.value as MetaPlatform); setAccountId(''); }}>
          {PLATFORMS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>

        <select className="input-field ch-select" aria-label="Account" style={{ minWidth: 160 }}
          value={accountId} onChange={e => setAccountId(e.target.value)}>
          <option value="">{platformAccounts.length ? 'Select an account…' : 'No connected accounts'}</option>
          {platformAccounts.map(a => (
            <option key={a.id} value={a.id}>{a.username ? `@${a.username}` : a.display_name ?? a.account_id}</option>
          ))}
        </select>

        <select className="input-field ch-select" aria-label="Mode"
          value={effMode} disabled={igForcesDuplicate} onChange={e => setMode(e.target.value as CrosspostMode)}>
          <option value="mirror">{CROSSPOST_MODE_LABEL['mirror']}</option>
          <option value="teaser">teaser</option>
        </select>

        <button type="button" className="btn-secondary btn-sm" disabled={!accountId || create.isPending} onClick={add}>
          {create.isPending ? 'Adding…' : 'Add'}
        </button>
        {igForcesDuplicate && (
          <p className="ch-note-inline">
            Instagram supports only <b>duplicate</b> (an image is required; links in captions aren&apos;t clickable).
          </p>
        )}
        {create.error && <p className="ch-form-error ch-note-inline">{describeError(create.error)}</p>}
      </div>
    </SectionCard>
  );
}
