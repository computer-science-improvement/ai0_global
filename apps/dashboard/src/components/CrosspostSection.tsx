// Cross-post management for one channel — used inside the Edit-strategy modal.
// Lists the channel's Meta cross-post targets and lets the operator add /
// toggle / remove them. Cross-posting fires after the channel's Telegram posts.

import { useState } from 'react';
import { Icon, type IconName } from './ui/Icon';
import { Badge } from './ui/Badge';
import { useConfirm } from './ui/ConfirmDialog';
import { useMetaAccounts } from '../api/meta-accounts';
import {
  useCrossposts, useCreateCrosspost, useToggleCrosspost, useDeleteCrosspost,
} from '../api/crossposts';
import type { MetaPlatform, CrosspostMode } from '../api/types';

const PLATFORMS: ReadonlyArray<{ key: MetaPlatform; label: string; icon: IconName }> = [
  { key: 'facebook',  label: 'Facebook',  icon: 'facebook' },
  { key: 'instagram', label: 'Instagram', icon: 'instagram' },
  { key: 'threads',   label: 'Threads',   icon: 'threads' },
];

export function CrosspostSection({ channelId }: { channelId: string }) {
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
  const igForcesMirror = platform === 'instagram';
  const effMode: CrosspostMode = igForcesMirror ? 'mirror' : mode;

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
    <div style={{ marginBottom: 16 }}>
      <div className="text-eyebrow" style={{ marginBottom: 6 }}>Meta cross-posting</div>
      <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: '0 0 10px' }}>
        After each Telegram post, this channel reposts to the selected Meta accounts.
        <b> mirror</b> — the same content; <b>teaser</b> — a short teaser + link to the post.
      </p>

      {/* Existing targets */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
        {(targets.data ?? []).map(t => {
          const meta = PLATFORMS.find(p => p.key === t.platform)!;
          return (
            <div key={t.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
              background: 'var(--color-surface-2)', borderRadius: 'var(--radius-md)',
            }}>
              <Icon name={meta.icon} size={14} />
              <span className="text-body-sm" style={{ color: 'var(--color-ink)' }}>{accountLabel(t.meta_account_id)}</span>
              <Badge tone="neutral">{t.mode}</Badge>
              {!t.enabled && <Badge tone="warning">disabled</Badge>}
              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
                <button className="btn-tiny" onClick={() => toggle.mutate({ id: t.id, enabled: !t.enabled })}>
                  {t.enabled ? 'Disable' : 'Enable'}
                </button>
                <button className="btn-tiny-danger" onClick={async () => {
                  if (await confirm(`remove cross-posting ${meta.label} → ${accountLabel(t.meta_account_id)}`)) remove.mutate(t.id);
                }}>Delete</button>
              </span>
            </div>
          );
        })}
        {targets.data && targets.data.length === 0 && (
          <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: 0 }}>No cross-posting targets yet.</p>
        )}
      </div>

      {/* Add a target */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select className="input-field" style={{ padding: '6px 10px', fontSize: 13 }}
          value={platform} onChange={e => { setPlatform(e.target.value as MetaPlatform); setAccountId(''); }}>
          {PLATFORMS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>

        <select className="input-field" style={{ padding: '6px 10px', fontSize: 13, minWidth: 160 }}
          value={accountId} onChange={e => setAccountId(e.target.value)}>
          <option value="">{platformAccounts.length ? 'Select an account…' : 'No connected accounts'}</option>
          {platformAccounts.map(a => (
            <option key={a.id} value={a.id}>{a.username ? `@${a.username}` : a.display_name ?? a.account_id}</option>
          ))}
        </select>

        <select className="input-field" style={{ padding: '6px 10px', fontSize: 13 }}
          value={effMode} disabled={igForcesMirror} onChange={e => setMode(e.target.value as CrosspostMode)}>
          <option value="mirror">mirror</option>
          <option value="teaser">teaser</option>
        </select>

        <button className="btn-primary" disabled={!accountId || create.isPending} onClick={add}>
          {create.isPending ? 'Adding…' : 'Add'}
        </button>
      </div>
      {igForcesMirror && (
        <p className="text-micro" style={{ color: 'var(--color-ink-dim)', marginTop: 6 }}>
          Instagram supports only <b>mirror</b> (an image is required; links in captions aren't clickable).
        </p>
      )}
      {create.error && (
        <p className="text-micro" style={{ color: 'var(--color-danger)', marginTop: 6 }}>{(create.error as Error).message}</p>
      )}
    </div>
  );
}
