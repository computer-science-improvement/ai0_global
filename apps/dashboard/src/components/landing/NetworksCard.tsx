// Spec 026 FR-015: the "Networks" card on /app/landing. The owner writes the one-line
// blurb each network shows on the public page and sets the order of the networks.
// Ordering renumbers every network to its index (like the resource list below it), so
// the default state where every network has order 0 still moves.
import { useEffect, useState, type JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Panel } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { TableAction } from '../ui/table';
import { toast } from '../ui/Toast';
import {
  landingApi, type LandingAdminNetwork, type LandingAdminNetworks,
} from '../../api/landing';
import { agentChip } from '../../lib/landing-view';

export const NETWORK_BLURB_MAX = 280;

function BlurbEditor({ n, disabled, onSave }: { n: LandingAdminNetwork; disabled: boolean; onSave: (blurb: string | null) => void }): JSX.Element {
  const [value, setValue] = useState(n.blurb ?? '');
  useEffect(() => { setValue(n.blurb ?? ''); }, [n.blurb]);
  const dirty = value.trim() !== (n.blurb ?? '').trim();
  const len = Array.from(value.trim()).length;
  const tooLong = len > NETWORK_BLURB_MAX;
  return (
    <div className="nc-blurb">
      <textarea
        className="input-field"
        rows={2}
        value={value}
        placeholder="One line about this network for the public page (optional)"
        onChange={(e) => setValue(e.target.value)}
        aria-label={`Public description of ${n.name}`}
        aria-invalid={tooLong}
        style={{ resize: 'vertical', width: '100%' }}
      />
      <div className="nc-row">
        <span className="text-micro" style={{ color: tooLong ? 'var(--color-danger)' : 'var(--color-ink-dim)' }}>
          {len}/{NETWORK_BLURB_MAX}
        </span>
        {dirty && (
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <Button variant="ghost" disabled={disabled} onClick={() => setValue(n.blurb ?? '')}>Discard</Button>
            <Button variant="primary" disabled={disabled || tooLong} onClick={() => onSave(value.trim() ? value.trim() : null)}>Save</Button>
          </span>
        )}
      </div>
    </div>
  );
}

export function NetworksCard({ data, isLoading, error }: { data: LandingAdminNetworks | undefined; isLoading: boolean; error: unknown }): JSX.Element {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: async (updates: Array<{ id: string; blurb?: string | null; order?: number }>) => {
      for (const u of updates) await landingApi.patchNetwork(u.id, { blurb: u.blurb, order: u.order });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['landing', 'admin', 'networks'] });
      qc.invalidateQueries({ queryKey: ['landing', 'networks'] });
    },
    onError: (e) => toast.error(`Couldn’t save the network: ${(e as Error).message}`),
  });

  if (isLoading) return <Panel title="Networks"><div className="la-skeleton" style={{ height: 96 }} /></Panel>;
  if (error || !data) {
    return (
      <Panel title="Networks">
        <div className="text-body-sm" style={{ color: 'var(--color-danger)' }}>
          Couldn’t load the networks{error ? `: ${(error as Error).message}` : ''}
        </div>
      </Panel>
    );
  }

  const list = data.networks;
  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[idx], next[j]] = [next[j], next[idx]];
    const updates = next.map((n, i) => ({ id: n.id, order: i, stored: n.order }))
      .filter((u) => u.stored !== u.order)
      .map(({ id, order }) => ({ id, order }));
    if (updates.length) save.mutate(updates);
  };

  return (
    <Panel
      title="Networks"
      action={<span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>{list.length} {list.length === 1 ? 'network' : 'networks'}</span>}
    >
      <p className="text-micro" style={{ margin: '0 0 12px', color: 'var(--color-ink-dim)' }}>
        The public page groups featured resources by network, in this order. A network shows only when at least one of its resources is featured.
      </p>
      {list.length === 0 && (
        <div className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>
          No networks yet. Group resources into networks under Connections → Groups.
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {list.map((n, i) => {
          const chip = agentChip(n.agent);
          return (
            <div key={n.id} className="nc-item">
              <div className="nc-item-head">
                <div className="nc-item-main">
                  <span className="text-body-sm" style={{ color: 'var(--color-ink)', fontWeight: 600 }}>{n.name}</span>
                  <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>
                    {n.featured}/{n.resources} featured
                  </span>
                  {chip
                    ? <Badge tone={n.agent?.mode === 'live' ? 'success' : 'warning'}>{chip}</Badge>
                    : <Badge>No agent</Badge>}
                </div>
                <div className="nc-item-actions">
                  <Badge tone="neutral">#{i + 1}</Badge>
                  <TableAction icon="chevron-up" title="Move up" disabled={i === 0 || save.isPending} onClick={() => move(i, -1)} />
                  <TableAction icon="chevron-down" title="Move down" disabled={i === list.length - 1 || save.isPending} onClick={() => move(i, 1)} />
                </div>
              </div>
              <BlurbEditor
                n={n}
                disabled={save.isPending}
                onSave={(blurb) => save.mutate([{ id: n.id, blurb }], { onSuccess: () => toast.success('Network description saved') })}
              />
            </div>
          );
        })}
      </div>
      <style>{`
        .nc-item {
          display: flex; flex-direction: column; gap: 8px;
          padding: 10px 12px;
          background: var(--color-surface-2);
          border: 1px solid var(--color-hairline);
          border-radius: var(--radius-md);
        }
        .nc-item-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
        .nc-item-main { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
        .nc-item-actions { display: inline-flex; align-items: center; gap: 6px; }
        .nc-blurb { display: flex; flex-direction: column; gap: 6px; }
        .nc-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      `}</style>
    </Panel>
  );
}
