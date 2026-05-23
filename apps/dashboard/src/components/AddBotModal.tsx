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
  const [tokenEnv, setTokenEnv] = useState('TELEGRAM_BOT_TOKEN');
  const create = useCreateBot();

  const submit = async () => {
    try {
      await create.mutateAsync({ bot_id: botId.trim(), token_env: tokenEnv.trim() });
      setBotId('');
      setTokenEnv('TELEGRAM_BOT_TOKEN');
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

      <Field label="Token env-var name">
        <input
          value={tokenEnv}
          onChange={e => setTokenEnv(e.target.value)}
          placeholder="TELEGRAM_BOT_TOKEN_2"
          className="input-field"
          style={{ width: '100%' }}
        />
      </Field>

      <div className="callout-warning" style={{ marginBottom: 16 }}>
        <Icon name="info" size={14} />
        <span className="text-micro">
          After saving, put the actual token into <code style={{ color: 'var(--color-ink)' }}>.env</code> as <code style={{ color: 'var(--color-ink)' }}>{tokenEnv || 'TELEGRAM_BOT_TOKEN'}=…</code> and restart automation. Then click <b>Verify</b>.
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
          disabled={!botId || !tokenEnv || create.isPending}
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
