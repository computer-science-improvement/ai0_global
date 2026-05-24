import { useQuery } from '@tanstack/react-query';
import { trackingApi } from '../api/tracking';
import { channelOptionLabel } from '../lib/labels';

interface Props {
  value:    string | null;
  onChange: (id: string | null) => void;
}

export function TargetChannelPicker({ value, onChange }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ['channels', { filter: 'mine' }],
    queryFn: () => trackingApi.listChannels({ filter: 'mine', pageSize: 100 }),
  });

  if (isLoading) {
    return (
      <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>
        Loading channels…
      </p>
    );
  }

  return (
    <select
      value={value ?? ''}
      onChange={e => onChange(e.target.value || null)}
      className="input-field"
      style={{ width: '100%' }}
    >
      <option value="">— pick a target channel —</option>
      {(data?.items ?? []).map(c => (
        <option key={c.id} value={c.id}>{channelOptionLabel(c)}</option>
      ))}
    </select>
  );
}
