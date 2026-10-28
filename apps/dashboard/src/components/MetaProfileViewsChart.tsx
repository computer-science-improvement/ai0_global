import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { format } from 'date-fns';
import type { MetaInsightDay } from '../api/meta-accounts';
import { usePrefersReducedMotion } from '../lib/useReducedMotion';

export function MetaProfileViewsChart({ points }: { points: MetaInsightDay[] }) {
  const reduced = usePrefersReducedMotion();
  const data = points.map(p => ({ at: new Date(p.day).getTime(), profileViews: p.profileViews ?? 0 }));
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <BarChart data={data}>
          <CartesianGrid stroke="var(--color-hairline)" strokeDasharray="3 3" />
          <XAxis dataKey="at" tickFormatter={(v) => format(v, 'MMM d')} stroke="var(--color-ink-muted)" tick={{ fill: 'var(--color-ink-muted)' }} />
          <YAxis stroke="var(--color-ink-muted)" tick={{ fill: 'var(--color-ink-muted)' }} />
          <Tooltip
            isAnimationActive={!reduced}
            contentStyle={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-md)', color: 'var(--color-ink)' }}
            labelStyle={{ color: 'var(--color-ink-muted)' }}
            labelFormatter={(v) => format(v as number, 'PP')}
          />
          <Bar isAnimationActive={!reduced} dataKey="profileViews" name="Profile views" fill="var(--color-accent)" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
