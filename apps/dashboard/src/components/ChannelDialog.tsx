// A channel opened from the graph: who it is, its ROI estimate and its subscriber history, with a way into the channel's
// own page. A dialog on the shared Modal, so Escape, the backdrop and the phone bottom sheet work like everywhere else.

import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { trackingApi } from '../api/tracking';
import { channelName } from '../lib/channel-view';
import { fmtNumber } from '../lib/format';
import { Modal } from './Modal';
import { SubsHistoryChart } from './SubsHistoryChart';
import { RoiPanel } from './RoiPanel';
import { ErrorCallout, LoadingNote } from './channels/ChannelsUi';
import { Icon } from './ui/Icon';
import { SectionCard } from './ui/primitives';
import './channels/channels.css';

export function ChannelDialog({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const channelQ = useQuery({ queryKey: ['channel', channelId], queryFn: () => trackingApi.getChannel(channelId) });
  const subsQ    = useQuery({ queryKey: ['subs', channelId],    queryFn: () => trackingApi.subsHistory(channelId) });

  const c = channelQ.data;
  const points = subsQ.data?.points ?? [];
  const subtitle = c
    ? [c.username ? `@${c.username}` : null, `${fmtNumber(c.subsCount)} subscribers`, `poll ${c.pollTier}`].filter(Boolean).join(' · ')
    : undefined;

  return (
    <Modal open onClose={onClose} title={c ? channelName(c) : 'Channel'} subtitle={subtitle} icon="channels" size="lg">
      {channelQ.isLoading && <LoadingNote note="Loading channel…" />}
      {channelQ.error && <ErrorCallout title="Couldn’t load the channel" message={(channelQ.error as Error).message} />}

      {c && (
        <div className="gr-dialog">
          <SectionCard title="ROI estimate">
            <RoiPanel channelId={channelId} />
          </SectionCard>
          {points.length > 0 && (
            <SectionCard title="Subscribers over time">
              <SubsHistoryChart points={points} />
            </SectionCard>
          )}
        </div>
      )}

      <div className="modal-foot">
        <button type="button" onClick={onClose} className="btn-ghost">Close</button>
        {c?.username && (
          <a href={`https://t.me/${c.username}`} target="_blank" rel="noopener noreferrer" className="btn-secondary">
            Open on Telegram
            <Icon name="external" size={14} />
          </a>
        )}
        {c && (
          <Link to="/app/channels/$id" params={{ id: channelId }} className="btn-primary">
            Open channel page
          </Link>
        )}
      </div>
    </Modal>
  );
}
