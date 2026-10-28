import { useQuery } from '@tanstack/react-query';
import { trackingApi } from '../api/tracking';
import { channelOptionLabel } from '../lib/labels';

interface Props {
  value:    string | null;
  onChange: (id: string | null) => void;
}

/** Which of my channels the placements are for. While the list loads (or fails) the select stays in place, disabled, so the form does not jump. */
export function TargetChannelPicker({ value, onChange }: Props) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['channels', { filter: 'mine' }],
    queryFn: () => trackingApi.listChannels({ filter: 'mine', pageSize: 100 }),
  });

  if (isLoading || isError) {
    return (
      <select className="input-field" aria-label="Target channel" disabled value="" style={{ width: '100%' }}>
        <option value="">{isLoading ? 'Loading channels…' : 'Couldn’t load your channels'}</option>
      </select>
    );
  }

  return (
    <select
      value={value ?? ''}
      onChange={e => onChange(e.target.value || null)}
      aria-label="Target channel"
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
