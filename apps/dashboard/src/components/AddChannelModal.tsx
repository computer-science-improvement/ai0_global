import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { trackingApi } from '../api/tracking';
import { Modal } from './Modal';

export function AddChannelModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [username, setUsername] = useState('');
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (u: string) => trackingApi.addChannel(u),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['channels'] }); setUsername(''); onClose(); },
  });

  return (
    <Modal open={open} onClose={onClose} title="Add channel">
      <form
        onSubmit={(e) => { e.preventDefault(); if (username) m.mutate(username.replace(/^@/, '')); }}
        style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <label>
          <span className="text-eyebrow" style={{ display: 'block', marginBottom: 6 }}>Username or @username</span>
          <input
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="durov or @durov"
            className="input-field"
            style={{ width: '100%' }}
          />
        </label>
        {m.error && (
          <p className="text-body-sm" style={{ color: 'var(--color-danger)', margin: 0 }}>
            {(m.error as Error).message}
          </p>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={!username || m.isPending} className="btn-primary">
            {m.isPending ? 'Adding…' : 'Add'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
