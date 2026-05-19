import { useQuery } from '@tanstack/react-query';
import { trackingApi } from '../api/tracking';

interface Props {
  value:    string | null;
  onChange: (id: string | null) => void;
}

export function TargetChannelPicker({ value, onChange }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ['channels', { filter: 'mine' }],
    queryFn: () => trackingApi.listChannels({ filter: 'mine', pageSize: 100 }),
  });

  if (isLoading) return <div className="text-sm text-gray-500">Loading channels…</div>;

  return (
    <select
      value={value ?? ''}
      onChange={e => onChange(e.target.value || null)}
      className="w-full rounded-md border px-3 py-2 text-sm"
    >
      <option value="">— pick a target channel —</option>
      {(data?.items ?? []).map(c => (
        <option key={c.id} value={c.id}>
          {c.title ?? c.username ?? c.id.slice(0, 8)}
        </option>
      ))}
    </select>
  );
}
