import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { format } from 'date-fns';
import type { TrackedPost } from '../api/types';

export function EngagementChart({ posts }: { posts: TrackedPost[] }) {
  const data = [...posts].reverse()
    .filter((p) => (p.views ?? 0) > 0)
    .map((p) => {
      const engage = (p.reactionsTotal ?? 0) + (p.forwards ?? 0) + (p.commentsCount ?? 0);
      return { at: new Date(p.postedAt).getTime(), rate: engage / (p.views ?? 1) };
    });
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <LineChart data={data}>
          <CartesianGrid stroke="var(--color-hairline)" strokeDasharray="3 3" />
          <XAxis dataKey="at" tickFormatter={(v) => format(v, 'MMM d')} stroke="var(--color-ink-muted)" tick={{ fill: 'var(--color-ink-muted)' }} />
          <YAxis stroke="var(--color-ink-muted)" tick={{ fill: 'var(--color-ink-muted)' }} tickFormatter={(v) => `${(v * 100).toFixed(1)}%`} />
          <Tooltip
            contentStyle={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-hairline)', borderRadius: 10, color: 'var(--color-ink)' }}
            labelStyle={{ color: 'var(--color-ink-muted)' }}
            formatter={(v) => typeof v === 'number' ? `${(v * 100).toFixed(2)}%` : String(v)}
            labelFormatter={(v) => format(v as number, 'PPp')}
          />
          <Line type="monotone" dataKey="rate" stroke="var(--color-grad-orange)" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
