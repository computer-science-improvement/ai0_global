// Spec 078 B1: the KPI strip of Today: Telegram subscribers, Meta followers, the agents' posts of the week and the AI spend of
// the week with its trend, then one line to the network health. A number that has not loaded yet shows a dash, never a zero.

import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { StatStrip, StatTile } from '../ui/primitives';
import { Button } from '../ui/Button';
import { trackingApi } from '../../api/tracking';
import { useMetaAccounts, useRefreshMetaStats } from '../../api/meta-accounts';
import { useNetworkHealth } from '../../api/health';
import { useAgentsOverview, useSpendBreakdown, useSpendSummary } from '../../api/spend';
import { deltaTone, fmtDelta, fmtUsd } from '../../lib/spend';
import { healthLabel, metaFollowersLine, reconnectCount } from '../../lib/today';
import './today.css';

const num = (n: number): string => n.toLocaleString('en-US');

export function TodayKpi({ delay }: { delay?: number }) {
  const channelsQ = useQuery({
    queryKey: ['channels', 'mine', 'overview'],
    queryFn: () => trackingApi.listChannels({ filter: 'mine', pageSize: 200 }),
  });
  const metaQ = useMetaAccounts();
  const refresh = useRefreshMetaStats();
  const healthQ = useNetworkHealth();
  const overviewQ = useAgentsOverview();
  const spendQ = useSpendSummary('7d');
  const dailyQ = useSpendBreakdown({ range: '7d', groupBy: 'day' });

  const channels = channelsQ.data?.items;
  const meta = metaQ.data;
  const week = spendQ.data?.periods['7d'];

  const subs = channels ? channels.reduce((n, c) => n + (c.subsCount ?? 0), 0) : null;
  const followers = meta ? meta.reduce((n, a) => n + (a.followers ?? 0), 0) : null;
  const delta24 = meta ? meta.reduce((n, a) => n + (a.followers_delta_24h ?? 0), 0) : 0;
  const metaLine = meta ? metaFollowersLine(reconnectCount(healthQ.data?.connections), delta24) : null;
  const posts = overviewQ.data?.posts;
  const spark = dailyQ.data?.chart.days.map((d) => d.total);

  return (
    <>
      <div className={delay != null ? 'compose-rise' : undefined} style={delay != null ? { animationDelay: `${delay}ms` } : undefined}>
        <StatStrip label="Key numbers">
          <StatTile
            label="Telegram subscribers" icon="channels"
            value={subs == null ? '—' : num(subs)}
            delta={channels ? `${channels.length} ${channels.length === 1 ? 'channel' : 'channels'}` : undefined}
          />
          <StatTile
            label="Meta followers" icon="connections"
            value={followers == null ? '—' : num(followers)}
            delta={metaLine?.text} deltaTone={metaLine?.tone}
          />
          <StatTile
            label="Agent posts · 7 days" icon="send"
            value={posts ? num(posts.d7.published) : '—'}
            delta={posts ? (posts.d7.shadowed > 0 ? `${num(posts.d7.shadowed)} more in shadow` : `${num(posts.today.published)} today`) : undefined}
          />
          <StatTile
            label="AI spend · 7 days" icon="spend"
            value={week ? fmtUsd(week.usd) : '—'}
            delta={week ? `${fmtDelta(week.deltaPct, week.prev.usd, week.usd)} vs the 7 days before` : undefined}
            deltaTone={week ? deltaTone(week.deltaPct) : undefined}
            spark={spark}
          />
        </StatStrip>
      </div>

      <div className="today-foot">
        {healthQ.data && (
          <Link to="/app/health" className="panel-link">
            Network health · {healthLabel(healthQ.data.problems)} →
          </Link>
        )}
        {meta && meta.length > 0 && (
          <Button type="button" variant="ghost" size="sm" disabled={refresh.isPending} onClick={() => refresh.mutate()}
            title="Fetch the latest follower counts and insights from Meta">
            {refresh.isPending ? 'Refreshing…' : 'Refresh Meta numbers'}
          </Button>
        )}
      </div>
    </>
  );
}
