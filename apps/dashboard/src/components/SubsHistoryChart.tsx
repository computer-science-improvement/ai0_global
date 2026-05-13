import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { format } from 'date-fns';
import type { SubsHistoryPoint } from '../api/types';

export function SubsHistoryChart({ points }: { points: SubsHistoryPoint[] }) {
  const data = points.map((p) => ({ at: new Date(p.at).getTime(), subs: p.subs }));
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <LineChart data={data}>
          <CartesianGrid stroke="#262626" strokeDasharray="3 3" />
          <XAxis dataKey="at" tickFormatter={(v) => format(v, 'MMM d')} stroke="#a3a3a3" />
          <YAxis stroke="#a3a3a3" />
          <Tooltip contentStyle={{ background: '#171717', border: '1px solid #404040' }}
            labelFormatter={(v) => format(v as number, 'PPp')} />
          <Line type="monotone" dataKey="subs" stroke="#10b981" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
