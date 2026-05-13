import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { format } from 'date-fns';
import type { TrackedPost } from '../api/types';

export function ViewsBarChart({ posts }: { posts: TrackedPost[] }) {
  const data = [...posts].reverse().map((p) => ({
    at: new Date(p.postedAt).getTime(), views: p.views ?? 0,
  }));
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <BarChart data={data}>
          <CartesianGrid stroke="#262626" strokeDasharray="3 3" />
          <XAxis dataKey="at" tickFormatter={(v) => format(v, 'MMM d')} stroke="#a3a3a3" />
          <YAxis stroke="#a3a3a3" />
          <Tooltip contentStyle={{ background: '#171717', border: '1px solid #404040' }}
            labelFormatter={(v) => format(v as number, 'PPp')} />
          <Bar dataKey="views" fill="#3b82f6" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
