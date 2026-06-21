import { useState } from 'react';
import { useAddMtprotoSession } from '../../api/mtproto-sessions';
import { Modal } from '../Modal';
import { Icon } from '../Icon';
import { Field } from '../ui/primitives';

interface Props {
  open:    boolean;
  onClose: () => void;
}

export function AddMtprotoSessionModal({ open, onClose }: Props) {
  const [label, setLabel]     = useState('');
  const [session, setSession] = useState('');
  const [apiId, setApiId]     = useState('');
  const [apiHash, setApiHash] = useState('');
  const [role, setRole]       = useState<'tracker' | 'agent'>('tracker');
  const create = useAddMtprotoSession();

  // apiId/apiHash are paired: provide both, or neither (then the .env app
  // credentials are used). A numeric api_id is required if either is filled.
  const apiIdValid = /^\d*$/.test(apiId.trim());
  const credsHalfFilled = (!!apiId.trim()) !== (!!apiHash.trim());
  const canSubmit =
    !!label.trim() && !!session.trim() && apiIdValid && !credsHalfFilled && !create.isPending;

  const submit = async () => {
    if (!canSubmit) return;
    try {
      await create.mutateAsync({
        label: label.trim(),
        session: session.trim(),
        apiId: apiId.trim() || undefined,
        apiHash: apiHash.trim() || undefined,
        role,
      });
      setLabel(''); setSession(''); setApiId(''); setApiHash(''); setRole('tracker');
      onClose();
    } catch {
      // Error shown via create.error below; modal stays open.
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add MTProto session" icon="telegram">
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

      <Field label="Role">
        <select
          value={role}
          onChange={e => setRole(e.target.value as 'tracker' | 'agent')}
          className="input-field"
          style={{ width: '100%' }}
        >
          <option value="tracker">Tracker — stats / competitor tracking</option>
          <option value="agent">Agent — read-only DM triage (SP1)</option>
        </select>
        <p className="text-micro" style={{ margin: '4px 0 0', color: 'var(--color-ink-dim)' }}>
          Agent = read-only DM triage; Tracker = stats/competitor tracking.
        </p>
      </Field>

      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: '0 0 140px' }}>
          <Field label="API ID">
            <input
              value={apiId}
              onChange={e => setApiId(e.target.value)}
              placeholder="1234567"
              inputMode="numeric"
              autoComplete="off"
              className="input-field"
              style={{ width: '100%', fontVariantNumeric: 'tabular-nums' }}
            />
          </Field>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Field label="API hash">
            <input
              value={apiHash}
              onChange={e => setApiHash(e.target.value)}
              placeholder="from my.telegram.org"
              autoComplete="off"
              spellCheck={false}
              className="input-field"
              style={{ width: '100%', fontFamily: 'var(--font-mono, monospace)', WebkitTextSecurity: 'disc' } as React.CSSProperties}
            />
          </Field>
        </div>
      </div>

      {!apiIdValid && (
        <p className="text-micro" style={{ color: 'var(--color-danger)', margin: '-4px 0 10px' }}>
          API ID must be numeric.
        </p>
      )}
      {credsHalfFilled && (
        <p className="text-micro" style={{ color: 'var(--color-danger)', margin: '-4px 0 10px' }}>
          Provide both API ID and API hash, or leave both empty to use the <code>.env</code> credentials.
        </p>
      )}

      <div className="callout-warning" style={{ marginBottom: 16 }}>
        <Icon name="info" size={14} />
        <span className="text-micro">
          The session string and API hash are encrypted on save — never stored in
          plaintext, logged, or shown again. The API ID/hash come from{' '}
          <b>my.telegram.org</b>; leave them empty to reuse the <code>.env</code>{' '}
          <code>TELEGRAM_API_ID</code> / <code>TELEGRAM_API_HASH</code>. After saving,
          click <b>Verify</b> to confirm the account it logs in as. The active session
          is used by the tracker and stats collectors (no restart needed on next read).
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
          disabled={!canSubmit}
          className="btn-primary"
        >
          {create.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}
