import { useState } from 'react';
import { useAddMtprotoSession } from '../../api/mtproto-sessions';
import { Modal } from '../Modal';
import { Icon } from '../Icon';

interface Props {
  open:    boolean;
  onClose: () => void;
}

export function AddMtprotoSessionModal({ open, onClose }: Props) {
  const [label, setLabel]     = useState('');
  const [session, setSession] = useState('');
  const create = useAddMtprotoSession();

  const submit = async () => {
    if (!label.trim() || !session.trim()) return;
    try {
      await create.mutateAsync({ label: label.trim(), session: session.trim() });
      setLabel(''); setSession('');
      onClose();
    } catch {
      // Error shown via create.error below; modal stays open.
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add MTProto session">
      <Field label="Label">
        <input
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder="Tracker account"
          className="input-field"
          style={{ width: '100%' }}
          maxLength={80}
        />
      </Field>

      <Field label="Session string">
        <textarea
          value={session}
          onChange={e => setSession(e.target.value)}
          placeholder="Paste the StringSession"
          autoComplete="off"
          spellCheck={false}
          className="input-field"
          style={{ width: '100%', minHeight: 96, fontFamily: 'var(--font-mono, monospace)', WebkitTextSecurity: 'disc' } as React.CSSProperties}
        />
      </Field>

      <div className="callout-warning" style={{ marginBottom: 16 }}>
        <Icon name="info" size={14} />
        <span className="text-micro">
          The session string is encrypted on save — it is never stored in plaintext,
          logged, or shown again. After saving, click <b>Verify</b> to confirm the
          account it logs in as. The active session is used by the tracker and stats
          collectors (no restart needed on next read).
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
          disabled={!label.trim() || !session.trim() || create.isPending}
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
