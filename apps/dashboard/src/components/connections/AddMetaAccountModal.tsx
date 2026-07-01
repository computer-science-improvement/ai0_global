import { useState } from 'react';
import { Modal } from '../Modal';
import { Icon } from '../ui/Icon';
import { Field } from '../ui/primitives';
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

  // The logical identifier is a slug, not a display name — mirror the server
  // rule (letters, digits, . _ -) client-side so a bad value (e.g. a space)
  // is caught inline instead of bouncing off a 400.
  const ID_RE = /^[A-Za-z0-9._-]+$/;
  const trimmedId = accountId.trim();
  const idValid = ID_RE.test(trimmedId);
  const idError = trimmedId.length > 0 && !idValid;
  const canSubmit = idValid && hasSecret && !!targetId.trim() && !create.isPending;

  const submit = async () => {
    if (!canSubmit) return;
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
    <Modal open={open} onClose={onClose} title={`Add ${d.label}`} icon={platform}>
      <Field label="Name (logical identifier)">
        <input value={accountId} onChange={e => setAccountId(e.target.value)}
          placeholder="my_page" className="input-field"
          style={{ width: '100%', borderColor: idError ? 'var(--color-danger)' : undefined }} />
        <span className="text-micro" style={{ display: 'block', marginTop: 4, color: idError ? 'var(--color-danger)' : 'var(--color-ink-dim)' }}>
          {idError
            ? 'Only letters, digits, . _ - — no spaces (e.g. ai0-recipes).'
            : 'A slug, not a display name. Letters, digits, . _ - only.'}
        </span>
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

      <div className="modal-foot">
        <button onClick={onClose} className="btn-secondary">Cancel</button>
        <button onClick={submit} disabled={!canSubmit} className="btn-primary">
          {create.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}
