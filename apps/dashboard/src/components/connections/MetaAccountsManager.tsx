// Meta accounts manager — one platform (Facebook / Instagram / Threads). Lists
// connected accounts as preview cards (mirrors the Telegram connection cards)
// with verify / pause / delete actions. Tokens live in .env; only the env-var
// NAME is ever shown.

import { useState } from 'react';
import { Icon } from '../ui/Icon';
import { Badge } from '../ui/Badge';
import { useConfirm } from '../ui/ConfirmDialog';
import { AddMetaAccountModal } from './AddMetaAccountModal';
import {
  useMetaAccounts, useVerifyMetaAccount, useToggleMetaAccount, useDeleteMetaAccount,
} from '../../api/meta-accounts';
import type { MetaAccount, MetaPlatform } from '../../api/types';

const PLATFORM_ICON: Record<MetaPlatform, 'facebook' | 'instagram' | 'threads'> = {
  facebook: 'facebook', instagram: 'instagram', threads: 'threads',
};

const PLATFORM_LABEL: Record<MetaPlatform, string> = {
  facebook: 'Facebook', instagram: 'Instagram', threads: 'Threads',
};

export function MetaAccountsManager({ platform }: { platform: MetaPlatform }) {
  const { data, isLoading, error } = useMetaAccounts();
  const verify = useVerifyMetaAccount();
  const toggle = useToggleMetaAccount();
  const remove = useDeleteMetaAccount();
  const confirm = useConfirm();
  const [addOpen, setAddOpen] = useState(false);

  const accounts = (data ?? []).filter(a => a.platform === platform);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div>
          <h2 className="text-eyebrow" style={{ margin: 0 }}>{PLATFORM_LABEL[platform]}</h2>
          <p className="text-micro" style={{ margin: '4px 0 0', color: 'var(--color-ink-dim)' }}>
            Акаунти {PLATFORM_LABEL[platform]}. Токени зберігаються у <code style={{ color: 'var(--color-ink-muted)' }}>.env</code>.
          </p>
        </div>
        <button onClick={() => setAddOpen(true)} className="btn-primary" style={{ gap: 6 }}>
          <Icon name="plus" size={14} /> Додати акаунт
        </button>
      </div>

      {isLoading && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Завантаження…</p>}
      {error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(error as Error).message}</p>}

      {!isLoading && accounts.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <p className="text-body" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>
            Ще немає акаунтів {PLATFORM_LABEL[platform]} — додайте, щоб підключити.
          </p>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {accounts.map(a => (
          <AccountCard
            key={a.id}
            account={a}
            onVerify={() => verify.mutate(a.id)}
            onToggle={async () => {
              const action = a.active ? 'призупинити' : 'активувати';
              if (await confirm(`${action} акаунт ${a.account_id}`, { danger: false, confirmLabel: a.active ? 'Призупинити' : 'Активувати' }))
                toggle.mutate({ id: a.id, active: !a.active });
            }}
            onDelete={async () => {
              if (await confirm(`видалити акаунт ${a.username ? `@${a.username}` : a.account_id}`))
                remove.mutate(a.id);
            }}
          />
        ))}
      </div>

      <AddMetaAccountModal open={addOpen} platform={platform} onClose={() => setAddOpen(false)} />
    </div>
  );
}

function AccountCard({ account: a, onVerify, onToggle, onDelete }: {
  account: MetaAccount;
  onVerify: () => void; onToggle: () => void; onDelete: () => void;
}) {
  const verified = !a.verify_error && !!a.username;
  return (
    <div className="card" style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
      <Avatar url={a.picture_url} platform={a.platform} />

      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="text-body" style={{ color: 'var(--color-ink)', fontWeight: 500 }}>
            {a.display_name ?? a.account_id}
          </span>
          {a.username && <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>@{a.username}</span>}
          {!a.active && <Badge tone="neutral">неактивний</Badge>}
        </div>
        <div className="text-caption" style={{ color: 'var(--color-ink-dim)', marginTop: 4 }}>
          {a.followers != null && <>{a.followers.toLocaleString()} підписників · </>}
          <code>{a.token_env}</code> · id <code>{a.target_id}</code>
          {a.last_verified_at && <> · перевірено {new Date(a.last_verified_at).toLocaleString()}</>}
        </div>
        <div style={{ marginTop: 8 }}>
          {a.verify_error
            ? <Badge tone="danger"><span title={a.verify_error}>{a.verify_error.slice(0, 48)}</span></Badge>
            : verified
              ? <Badge tone="success">підключено</Badge>
              : <Badge tone="neutral">не перевірено</Badge>}
        </div>
      </div>

      <div style={{ display: 'inline-flex', gap: 6 }}>
        <button onClick={onVerify} className="btn-tiny" title="Перевірити токен"><Icon name="refresh" size={12} /> Verify</button>
        <button onClick={onToggle} className="btn-tiny">{a.active ? 'Призупинити' : 'Активувати'}</button>
        <button onClick={onDelete} className="btn-tiny-danger"><Icon name="trash" size={12} /> Видалити</button>
      </div>
    </div>
  );
}

function Avatar({ url, platform }: { url: string | null; platform: MetaPlatform }) {
  const size = 48;
  if (url) {
    return <img src={url} alt="" width={size} height={size}
      style={{ borderRadius: 999, objectFit: 'cover', flexShrink: 0 }} />;
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: 999, flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--color-surface-3)', color: 'var(--color-ink-muted)',
    }}>
      <Icon name={PLATFORM_ICON[platform]} size={22} />
    </div>
  );
}
