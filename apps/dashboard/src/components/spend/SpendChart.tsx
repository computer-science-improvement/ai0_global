import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import type { SpendBreakdown } from '../../api/spend';
import { fmtUsd, seriesColor } from '../../lib/spend';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDay = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;

/** Daily USD stacked by provider or feature family (spec 029 FR-010). Days are Kyiv days. */
export function SpendChart({ chart }: { chart: SpendBreakdown['chart'] }) {
  const data = chart.days.map((d) => ({ day: d.day, ...d.values }));
  return (
    <div style={{ width: '100%', height: 'clamp(220px, 34vh, 300px)' }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }} barCategoryGap="18%">
          <CartesianGrid stroke="var(--color-hairline)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="day" tickFormatter={shortDay} tick={{ fill: 'var(--color-ink-muted)', fontSize: 11 }} tickMargin={8}
            minTickGap={20} interval="preserveStartEnd" axisLine={false} tickLine={false} />
          <YAxis tickFormatter={(v) => fmtUsd(Number(v))} tick={{ fill: 'var(--color-ink-muted)', fontSize: 11 }} width={52} axisLine={false} tickLine={false} />
          <Tooltip
            cursor={{ fill: 'var(--color-accent)', opacity: 0.08 }}
            contentStyle={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-hairline)', borderRadius: 10, color: 'var(--color-ink)', boxShadow: '0 8px 28px rgba(0,0,0,0.28)' }}
            labelStyle={{ color: 'var(--color-ink-muted)', fontSize: 12 }}
            itemStyle={{ color: 'var(--color-ink)', fontSize: 12 }}
            labelFormatter={(v) => `${v} (Kyiv)`}
            formatter={(value, name) => [fmtUsd(Number(value)), String(name)]}
          />
          <Legend wrapperStyle={{ fontSize: 11, color: 'var(--color-ink-muted)' }} iconSize={9} />
          {chart.series.map((s, i) => (
            <Bar key={s} dataKey={s} name={s} stackId="usd" fill={seriesColor(s, i)}
              radius={i === chart.series.length - 1 ? [3, 3, 0, 0] : undefined} maxBarSize={40} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
