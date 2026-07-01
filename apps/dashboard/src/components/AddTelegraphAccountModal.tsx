import { useState } from 'react';
import { useCreateTelegraphAccount } from '../api/telegraph';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { Field } from './ui/primitives';

interface Props {
  open:    boolean;
  onClose: () => void;
}

export function AddTelegraphAccountModal({ open, onClose }: Props) {
  const [accountId, setAccountId]   = useState('');
  const [token, setToken]           = useState('');
  const [tokenEnv, setTokenEnv]     = useState('');
  const [authorName, setAuthorName] = useState('');
  const [authorUrl, setAuthorUrl]   = useState('');
  const create = useCreateTelegraphAccount();

  // Require either the token value or the legacy env-var name.
  const hasSecret = !!token.trim() || !!tokenEnv.trim();

  const submit = async () => {
    if (!hasSecret) return;
    try {
      await create.mutateAsync({
        account_id:  accountId.trim(),
        // Send the token VALUE when provided (server encrypts); else the env-var name.
        token:       token.trim() || undefined,
        token_env:   token.trim() ? undefined : (tokenEnv.trim() || undefined),
        author_name: authorName.trim() || undefined,
        author_url:  authorUrl.trim() || undefined,
      });
      setAccountId(''); setToken(''); setTokenEnv(''); setAuthorName(''); setAuthorUrl('');
      onClose();
    } catch {
      // Error shown via create.error below; modal stays open.
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add Telegraph account" icon="telegraph">
      <Field label="Account id (logical name)">
        <input
          value={accountId}
          onChange={e => setAccountId(e.target.value)}
          placeholder="default"
          className="input-field"
          style={{ width: '100%' }}
        />
      </Field>

      <Field label="Token (value)">
        <input
          type="password"
          value={token}
          onChange={e => setToken(e.target.value)}
          placeholder="Paste the Telegraph access token"
          autoComplete="off"
          className="input-field"
          style={{ width: '100%' }}
        />
      </Field>

      <Field label="…or env variable name (legacy)">
        <input
          value={tokenEnv}
          onChange={e => setTokenEnv(e.target.value)}
          placeholder="TELEGRAPH_ACCESS_TOKEN"
          className="input-field"
          style={{ width: '100%' }}
          disabled={!!token.trim()}
        />
      </Field>

      <Field label="Author name (optional)">
        <input
          value={authorName}
          onChange={e => setAuthorName(e.target.value)}
          placeholder="ai0"
          className="input-field"
          style={{ width: '100%' }}
        />
      </Field>

      <Field label="Author URL (optional)">
        <input
          value={authorUrl}
          onChange={e => setAuthorUrl(e.target.value)}
          placeholder="https://t.me/your_channel"
          className="input-field"
          style={{ width: '100%' }}
        />
      </Field>

      <div className="callout-warning" style={{ marginBottom: 16 }}>
        <Icon name="info" size={14} />
        <span className="text-micro">
          {token.trim()
            ? <>The token is encrypted on save — it is never stored in plaintext or shown again. Click <b>Verify</b> after saving. Mint a token via <code style={{ color: 'var(--color-ink)' }}>api.telegra.ph/createAccount</code>.</>
            : <>Put the Telegraph access token into <code style={{ color: 'var(--color-ink)' }}>.env</code> as <code style={{ color: 'var(--color-ink)' }}>{tokenEnv || 'TELEGRAPH_ACCESS_TOKEN'}=…</code> and restart automation. Then click <b>Verify</b>. Or paste the token value above to store it encrypted. Mint a token via <code style={{ color: 'var(--color-ink)' }}>api.telegra.ph/createAccount</code>.</>}
        </span>
      </div>

      {create.error && (
        <p className="text-body-sm" style={{ color: 'var(--color-danger)', marginBottom: 12 }}>
          {(create.error as Error).message}
        </p>
      )}

      <div className="modal-foot">
        <button onClick={onClose} className="btn-secondary">Cancel</button>
        <button
          onClick={submit}
          disabled={!accountId || !hasSecret || create.isPending}
          className="btn-primary"
        >
          {create.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}
