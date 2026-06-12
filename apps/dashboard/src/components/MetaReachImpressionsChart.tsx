import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { format } from 'date-fns';
import type { MetaInsightDay } from '../api/meta-accounts';

export function MetaReachImpressionsChart({ points }: { points: MetaInsightDay[] }) {
  const data = points.map(p => ({ at: new Date(p.day).getTime(), reach: p.reach, impressions: p.impressions }));
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <LineChart data={data}>
          <CartesianGrid stroke="var(--color-hairline)" strokeDasharray="3 3" />
          <XAxis dataKey="at" tickFormatter={(v) => format(v, 'MMM d')} stroke="var(--color-ink-muted)" tick={{ fill: 'var(--color-ink-muted)' }} />
          <YAxis stroke="var(--color-ink-muted)" tick={{ fill: 'var(--color-ink-muted)' }} />
          <Tooltip
            contentStyle={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-hairline)', borderRadius: 10, color: 'var(--color-ink)' }}
            labelStyle={{ color: 'var(--color-ink-muted)' }}
            labelFormatter={(v) => format(v as number, 'PP')}
          />
          <Legend />
          <Line type="monotone" dataKey="reach" name="Reach" stroke="var(--color-accent)" strokeWidth={2} dot={false} connectNulls />
          <Line type="monotone" dataKey="impressions" name="Impressions" stroke="var(--color-grad-orange)" strokeWidth={2} dot={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
