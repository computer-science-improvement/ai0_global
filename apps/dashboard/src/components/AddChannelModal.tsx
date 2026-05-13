import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { trackingApi } from '../api/tracking';

export function AddChannelModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [username, setUsername] = useState('');
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (u: string) => trackingApi.addChannel(u),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['channels'] }); setUsername(''); onClose(); },
  });
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.72)' }} onClick={onClose}>
      <div
        className="w-full max-w-md card-featured"
        style={{ border: '1px solid var(--color-hairline)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-5 text-headline" style={{ color: 'var(--color-ink)' }}>Add channel</h2>
        <form onSubmit={(e) => { e.preventDefault(); if (username) m.mutate(username.replace(/^@/, '')); }} className="space-y-4">
          <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)}
            placeholder="durov or @durov"
            className="input-field w-full" />
          {m.error && <p className="text-sm" style={{ color: 'var(--color-danger)' }}>{(m.error as Error).message}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
            <button type="submit" disabled={!username || m.isPending} className="btn-primary">
              {m.isPending ? 'Adding…' : 'Add'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
