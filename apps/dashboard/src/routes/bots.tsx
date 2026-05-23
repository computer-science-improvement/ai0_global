import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { AddBotModal } from '../components/AddBotModal';
import {
  useBots, useDeleteBot, useToggleBotActive, useVerifyBot,
} from '../api/bots';

export const Route = createFileRoute('/bots')({ component: BotsPage });

function BotsPage() {
  const { data, isLoading, error } = useBots();
  const verify  = useVerifyBot();
  const toggle  = useToggleBotActive();
  const remove  = useDeleteBot();
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 className="text-display-md" style={{ margin: 0 }}>Bots</h1>
        <button onClick={() => setAddOpen(true)} className="btn-primary">+ Add bot</button>
      </header>

      {isLoading && <p style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>}
      {error && <p style={{ color: 'var(--color-danger)' }}>{(error as Error).message}</p>}

      {data && data.length === 0 && (
        <p style={{ color: 'var(--color-ink-muted)' }}>No bots configured yet.</p>
      )}

      {data && data.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-3 py-2">Bot id</th>
                <th className="px-3 py-2">Username</th>
                <th className="px-3 py-2">Token env</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Last verified</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.map(b => (
                <tr key={b.id} className="border-t hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono text-xs">{b.bot_id}</td>
                  <td className="px-3 py-2">{b.username ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs">{b.token_env}</td>
                  <td className="px-3 py-2">
                    {b.verify_error
                      ? <span title={b.verify_error} style={{ color: 'var(--color-danger)' }}>⚠ {b.verify_error.slice(0, 40)}</span>
                      : b.username
                        ? <span style={{ color: 'var(--color-success, #16a34a)' }}>✓ verified</span>
                        : <span style={{ color: 'var(--color-ink-muted)' }}>unverified</span>}
                    {!b.active && <span style={{ marginLeft: 8, color: 'var(--color-ink-muted)' }}>(inactive)</span>}
                  </td>
                  <td className="px-3 py-2 text-xs" style={{ color: 'var(--color-ink-muted)' }}>
                    {b.last_verified_at ? new Date(b.last_verified_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-3 py-2">
                    <button onClick={() => verify.mutate(b.id)} className="text-sm text-blue-600 hover:underline mr-3">
                      Verify
                    </button>
                    <button
                      onClick={() => toggle.mutate({ id: b.id, active: !b.active })}
                      className="text-sm text-blue-600 hover:underline mr-3"
                    >
                      {b.active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Delete bot ${b.bot_id}?`)) remove.mutate(b.id);
                      }}
                      className="text-sm text-red-600 hover:underline"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AddBotModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
