import { useState } from 'react';
import { Modal } from '../Modal';
import { Icon } from '../ui/Icon';
import { useCreateMetaAccount } from '../../api/meta-accounts';
import type { MetaPlatform } from '../../api/types';

const DEFAULTS: Record<MetaPlatform, { label: string; tokenEnv: string; targetHint: string }> = {
  facebook:  { label: 'Facebook',  tokenEnv: 'FACEBOOK_PAGE_TOKEN', targetHint: 'Page id (напр. 1029384756)' },
  instagram: { label: 'Instagram', tokenEnv: 'INSTAGRAM_TOKEN',     targetHint: 'IG business-account id' },
  threads:   { label: 'Threads',   tokenEnv: 'THREADS_TOKEN',       targetHint: 'Threads user id' },
};

interface Props {
  open:     boolean;
  platform: MetaPlatform;
  onClose:  () => void;
}

export function AddMetaAccountModal({ open, platform, onClose }: Props) {
  const d = DEFAULTS[platform];
  const [accountId, setAccountId] = useState('');
  const [tokenEnv, setTokenEnv]   = useState(d.tokenEnv);
  const [targetId, setTargetId]   = useState('');
  const create = useCreateMetaAccount();

  const submit = async () => {
    try {
      await create.mutateAsync({ platform, accountId: accountId.trim(), tokenEnv: tokenEnv.trim(), targetId: targetId.trim() });
      setAccountId(''); setTokenEnv(d.tokenEnv); setTargetId('');
      onClose();
    } catch { /* error shown below; modal stays open */ }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Додати ${d.label}`}>
      <Field label="Назва (логічний ідентифікатор)">
        <input value={accountId} onChange={e => setAccountId(e.target.value)}
          placeholder="my_page" className="input-field" style={{ width: '100%' }} />
      </Field>

      <Field label="Назва env-змінної з токеном">
        <input value={tokenEnv} onChange={e => setTokenEnv(e.target.value)}
          placeholder={d.tokenEnv} className="input-field" style={{ width: '100%' }} />
      </Field>

      <Field label="Target id">
        <input value={targetId} onChange={e => setTargetId(e.target.value)}
          placeholder={d.targetHint} className="input-field" style={{ width: '100%' }} />
      </Field>

      <div className="callout-warning" style={{ marginBottom: 16 }}>
        <Icon name="info" size={14} />
        <span className="text-micro">
          Збережіть токен у <code style={{ color: 'var(--color-ink)' }}>.env</code> як{' '}
          <code style={{ color: 'var(--color-ink)' }}>{tokenEnv || d.tokenEnv}=…</code>, перезапустіть automation, тоді натисніть <b>Verify</b>.
        </span>
      </div>

      {create.error && (
        <p className="text-body-sm" style={{ color: 'var(--color-danger)', marginBottom: 12 }}>
          {(create.error as Error).message}
        </p>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onClose} className="btn-secondary">Скасувати</button>
        <button onClick={submit} disabled={!accountId || !tokenEnv || !targetId || create.isPending} className="btn-primary">
          {create.isPending ? 'Збереження…' : 'Зберегти'}
        </button>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: 12 }}>
      <span className="text-eyebrow" style={{ display: 'block', marginBottom: 6 }}>{label}</span>
      {children}
    </label>
  );
}
