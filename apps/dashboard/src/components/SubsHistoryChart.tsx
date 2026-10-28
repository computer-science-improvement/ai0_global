import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { format } from 'date-fns';
import type { SubsHistoryPoint } from '../api/types';
import { usePrefersReducedMotion } from '../lib/useReducedMotion';

export function SubsHistoryChart({ points }: { points: SubsHistoryPoint[] }) {
  const reduced = usePrefersReducedMotion();
  const data = points.map((p) => ({ at: new Date(p.at).getTime(), subs: p.subs }));
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <LineChart data={data}>
          <CartesianGrid stroke="var(--color-hairline)" strokeDasharray="3 3" />
          <XAxis dataKey="at" tickFormatter={(v) => format(v, 'MMM d')} stroke="var(--color-ink-muted)" tick={{ fill: 'var(--color-ink-muted)' }} />
          <YAxis stroke="var(--color-ink-muted)" tick={{ fill: 'var(--color-ink-muted)' }} />
          <Tooltip
            isAnimationActive={!reduced}
            contentStyle={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-md)', color: 'var(--color-ink)' }}
            labelStyle={{ color: 'var(--color-ink-muted)' }}
            labelFormatter={(v) => format(v as number, 'PPp')}
          />
          <Line isAnimationActive={!reduced} type="monotone" dataKey="subs" stroke="var(--color-accent)" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
