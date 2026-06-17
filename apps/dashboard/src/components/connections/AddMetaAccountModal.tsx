import { useState } from 'react';
import { Modal } from '../Modal';
import { Icon } from '../ui/Icon';
import { useCreateMetaAccount } from '../../api/meta-accounts';
import type { MetaPlatform } from '../../api/types';

const DEFAULTS: Record<MetaPlatform, { label: string; tokenEnv: string; targetHint: string }> = {
  facebook:  { label: 'Facebook',  tokenEnv: 'FACEBOOK_PAGE_TOKEN', targetHint: 'Page id (e.g. 1029384756)' },
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
  const [token, setToken]         = useState('');
  const [tokenEnv, setTokenEnv]   = useState('');
  const [targetId, setTargetId]   = useState('');
  const create = useCreateMetaAccount();

  // Require either the token value or the legacy env-var name.
  const hasSecret = !!token.trim() || !!tokenEnv.trim();

  const submit = async () => {
    if (!hasSecret) return;
    try {
      await create.mutateAsync({
        platform,
        accountId: accountId.trim(),
        // Send the token VALUE when provided (server encrypts); else the env-var name.
        token:    token.trim() || undefined,
        tokenEnv: token.trim() ? undefined : (tokenEnv.trim() || undefined),
        targetId: targetId.trim(),
      });
      setAccountId(''); setToken(''); setTokenEnv(''); setTargetId('');
      onClose();
    } catch { /* error shown below; modal stays open */ }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Add ${d.label}`}>
      <Field label="Name (logical identifier)">
        <input value={accountId} onChange={e => setAccountId(e.target.value)}
          placeholder="my_page" className="input-field" style={{ width: '100%' }} />
      </Field>

      <Field label="Token (value)">
        <input type="password" value={token} onChange={e => setToken(e.target.value)}
          placeholder="Paste the access token" autoComplete="off"
          className="input-field" style={{ width: '100%' }} />
      </Field>

      <Field label="…or env variable name (legacy)">
        <input value={tokenEnv} onChange={e => setTokenEnv(e.target.value)}
          placeholder={d.tokenEnv} className="input-field" style={{ width: '100%' }}
          disabled={!!token.trim()} />
      </Field>

      <Field label="Target id">
        <input value={targetId} onChange={e => setTargetId(e.target.value)}
          placeholder={d.targetHint} className="input-field" style={{ width: '100%' }} />
      </Field>

      <div className="callout-warning" style={{ marginBottom: 16 }}>
        <Icon name="info" size={14} />
        <span className="text-micro">
          {token.trim()
            ? <>The token is encrypted on save — it is never stored in plaintext or shown again. Click <b>Verify</b> after saving.</>
            : <>Save the token in <code style={{ color: 'var(--color-ink)' }}>.env</code> as{' '}
                <code style={{ color: 'var(--color-ink)' }}>{tokenEnv || d.tokenEnv}=…</code>, restart automation, then click <b>Verify</b>. Or paste the token value above to store it encrypted.</>}
        </span>
      </div>

      {create.error && (
        <p className="text-body-sm" style={{ color: 'var(--color-danger)', marginBottom: 12 }}>
          {(create.error as Error).message}
        </p>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onClose} className="btn-secondary">Cancel</button>
        <button onClick={submit} disabled={!accountId || !hasSecret || !targetId || create.isPending} className="btn-primary">
          {create.isPending ? 'Saving…' : 'Save'}
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
