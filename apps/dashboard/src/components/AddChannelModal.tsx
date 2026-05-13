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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-neutral-900 p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-lg font-semibold">Add channel</h2>
        <form onSubmit={(e) => { e.preventDefault(); if (username) m.mutate(username.replace(/^@/, '')); }} className="space-y-3">
          <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)}
            placeholder="durov or @durov"
            className="w-full rounded-lg bg-neutral-800 px-3 py-2 outline-none ring-1 ring-neutral-700 focus:ring-neutral-500" />
          {m.error && <p className="text-sm text-red-400">{(m.error as Error).message}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded bg-neutral-800 px-3 py-2 hover:bg-neutral-700">Cancel</button>
            <button type="submit" disabled={!username || m.isPending} className="rounded bg-emerald-600 px-4 py-2 hover:bg-emerald-500 disabled:opacity-50">
              {m.isPending ? 'Adding…' : 'Add'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
