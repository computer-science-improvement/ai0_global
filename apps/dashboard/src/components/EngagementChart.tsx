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
          <CartesianGrid stroke="#262626" strokeDasharray="3 3" />
          <XAxis dataKey="at" tickFormatter={(v) => format(v, 'MMM d')} stroke="#a3a3a3" />
          <YAxis stroke="#a3a3a3" tickFormatter={(v) => `${(v * 100).toFixed(1)}%`} />
          <Tooltip contentStyle={{ background: '#171717', border: '1px solid #404040' }}
            formatter={(v: number) => `${(v * 100).toFixed(2)}%`}
            labelFormatter={(v) => format(v as number, 'PPp')} />
          <Line type="monotone" dataKey="rate" stroke="#f59e0b" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
