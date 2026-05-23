import { useState } from 'react';
import { useCreateBot } from '../api/bots';

interface Props {
  open:    boolean;
  onClose: () => void;
}

export function AddBotModal({ open, onClose }: Props) {
  const [botId, setBotId]       = useState('');
  const [tokenEnv, setTokenEnv] = useState('TELEGRAM_BOT_TOKEN');
  const create = useCreateBot();

  if (!open) return null;

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
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.72)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 480,
          background: 'var(--color-canvas)',
          border: '1px solid var(--color-hairline)',
          borderRadius: 12, padding: 24,
        }}
      >
        <h2 style={{ margin: 0, marginBottom: 16, color: 'var(--color-ink)', fontSize: 18 }}>
          Add bot
        </h2>

        <label style={{ display: 'block', marginBottom: 12 }}>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--color-ink-muted)', marginBottom: 4 }}>
            Bot id (logical name)
          </span>
          <input
            value={botId}
            onChange={e => setBotId(e.target.value)}
            placeholder="ai0_partners_bot"
            className="input-field w-full"
          />
        </label>

        <label style={{ display: 'block', marginBottom: 12 }}>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--color-ink-muted)', marginBottom: 4 }}>
            Token env-var name
          </span>
          <input
            value={tokenEnv}
            onChange={e => setTokenEnv(e.target.value)}
            placeholder="TELEGRAM_BOT_TOKEN_2"
            className="input-field w-full"
          />
        </label>

        <p style={{ fontSize: 12, color: 'var(--color-ink-muted)', marginTop: 4, marginBottom: 16 }}>
          After saving, put the actual token into your <code>.env</code> as <code>{tokenEnv || 'TELEGRAM_BOT_TOKEN'}=...</code> and restart automation. Then click <b>Verify</b> on the row.
        </p>

        {create.error && (
          <p style={{ color: 'var(--color-danger)', fontSize: 13, marginBottom: 12 }}>
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
      </div>
    </div>
  );
}
