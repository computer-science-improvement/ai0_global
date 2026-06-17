import { useState } from 'react';
import { useCreateBot } from '../api/bots';
import { Modal } from './Modal';
import { Icon } from './Icon';

interface Props {
  open:    boolean;
  onClose: () => void;
}

export function AddBotModal({ open, onClose }: Props) {
  const [botId, setBotId]       = useState('');
  const [token, setToken]       = useState('');
  const [tokenEnv, setTokenEnv] = useState('');
  const create = useCreateBot();

  // Require either the token value or the legacy env-var name.
  const hasSecret = !!token.trim() || !!tokenEnv.trim();

  const submit = async () => {
    if (!hasSecret) return;
    try {
      await create.mutateAsync({
        bot_id:    botId.trim(),
        // Send the token VALUE when provided (server encrypts); else the env-var name.
        token:     token.trim() || undefined,
        token_env: token.trim() ? undefined : (tokenEnv.trim() || undefined),
      });
      setBotId(''); setToken(''); setTokenEnv('');
      onClose();
    } catch {
      // Error shown via create.error below; modal stays open.
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add bot">
      <Field label="Bot id (logical name)">
        <input
          value={botId}
          onChange={e => setBotId(e.target.value)}
          placeholder="ai0_partners_bot"
          className="input-field"
          style={{ width: '100%' }}
        />
      </Field>

      <Field label="Token (value)">
        <input
          type="password"
          value={token}
          onChange={e => setToken(e.target.value)}
          placeholder="Paste the bot token"
          autoComplete="off"
          className="input-field"
          style={{ width: '100%' }}
        />
      </Field>

      <Field label="…or env variable name (legacy)">
        <input
          value={tokenEnv}
          onChange={e => setTokenEnv(e.target.value)}
          placeholder="TELEGRAM_BOT_TOKEN_2"
          className="input-field"
          style={{ width: '100%' }}
          disabled={!!token.trim()}
        />
      </Field>

      <div className="callout-warning" style={{ marginBottom: 16 }}>
        <Icon name="info" size={14} />
        <span className="text-micro">
          {token.trim()
            ? <>The token is encrypted on save — it is never stored in plaintext or shown again. Click <b>Verify</b> after saving.</>
            : <>Put the token into <code style={{ color: 'var(--color-ink)' }}>.env</code> as <code style={{ color: 'var(--color-ink)' }}>{tokenEnv || 'TELEGRAM_BOT_TOKEN'}=…</code> and restart automation. Then click <b>Verify</b>. Or paste the token value above to store it encrypted.</>}
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
          disabled={!botId || !hasSecret || create.isPending}
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
