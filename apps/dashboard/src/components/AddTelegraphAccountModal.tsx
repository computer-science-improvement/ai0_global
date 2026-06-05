import { useState } from 'react';
import { useCreateTelegraphAccount } from '../api/telegraph';
import { Modal } from './Modal';
import { Icon } from './Icon';

interface Props {
  open:    boolean;
  onClose: () => void;
}

export function AddTelegraphAccountModal({ open, onClose }: Props) {
  const [accountId, setAccountId]   = useState('');
  const [tokenEnv, setTokenEnv]     = useState('TELEGRAPH_ACCESS_TOKEN');
  const [authorName, setAuthorName] = useState('');
  const [authorUrl, setAuthorUrl]   = useState('');
  const create = useCreateTelegraphAccount();

  const submit = async () => {
    try {
      await create.mutateAsync({
        account_id:  accountId.trim(),
        token_env:   tokenEnv.trim(),
        author_name: authorName.trim() || undefined,
        author_url:  authorUrl.trim() || undefined,
      });
      setAccountId(''); setTokenEnv('TELEGRAPH_ACCESS_TOKEN'); setAuthorName(''); setAuthorUrl('');
      onClose();
    } catch {
      // Error shown via create.error below; modal stays open.
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add Telegraph account">
      <Field label="Account id (logical name)">
        <input
          value={accountId}
          onChange={e => setAccountId(e.target.value)}
          placeholder="default"
          className="input-field"
          style={{ width: '100%' }}
        />
      </Field>

      <Field label="Token env-var name">
        <input
          value={tokenEnv}
          onChange={e => setTokenEnv(e.target.value)}
          placeholder="TELEGRAPH_ACCESS_TOKEN"
          className="input-field"
          style={{ width: '100%' }}
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
          After saving, put the Telegraph access token into <code style={{ color: 'var(--color-ink)' }}>.env</code> as <code style={{ color: 'var(--color-ink)' }}>{tokenEnv || 'TELEGRAPH_ACCESS_TOKEN'}=…</code> and restart automation. Then click <b>Verify</b>. Mint a token via <code style={{ color: 'var(--color-ink)' }}>api.telegra.ph/createAccount</code>.
        </span>
      </div>

      {create.error && (
        <p className="text-body-sm" style={{ color: 'var(--color-danger)', marginBottom: 12 }}>
          {(create.error as Error).message}
        </p>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onClose} className="btn-secondary">Cancel</button>
        <button
          onClick={submit}
          disabled={!accountId || !tokenEnv || create.isPending}
          className="btn-primary"
        >
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
