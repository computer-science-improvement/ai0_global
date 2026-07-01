import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell } from 'recharts';
import { format } from 'date-fns';
import type { TrackedPost } from '../api/types';

// Compact axis ticks (1.2k / 3.4M) so the Y-axis stays narrow on small screens;
// full grouped number in the tooltip.
const compact = (n: number) => Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

export function ViewsBarChart({ posts }: { posts: TrackedPost[] }) {
  const data = [...posts].reverse().map((p) => ({
    at: new Date(p.postedAt).getTime(), views: p.views ?? 0,
  }));
  const peak = Math.max(0, ...data.map((d) => d.views));

  return (
    // Fluid height: comfortable on desktop, never cramped on a phone.
    <div style={{ width: '100%', height: 'clamp(220px, 38vh, 320px)' }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }} barCategoryGap="22%">
          <defs>
            <linearGradient id="views-bar" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="var(--color-accent)" stopOpacity={0.95} />
              <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0.45} />
            </linearGradient>
          </defs>
          {/* Horizontal guides only — vertical grid is noise on a bar chart. */}
          <CartesianGrid stroke="var(--color-hairline)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="at"
            tickFormatter={(v) => format(v, 'MMM d')}
            tick={{ fill: 'var(--color-ink-muted)', fontSize: 11 }}
            tickMargin={8}
            minTickGap={24}
            interval="preserveStartEnd"
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tickFormatter={compact}
            tick={{ fill: 'var(--color-ink-muted)', fontSize: 11 }}
            width={40}
            axisLine={false}
            tickLine={false}
            allowDecimals={false}
          />
          <Tooltip
            cursor={{ fill: 'var(--color-accent)', opacity: 0.08 }}
            contentStyle={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-hairline)', borderRadius: 10, color: 'var(--color-ink)', boxShadow: '0 8px 28px rgba(0,0,0,0.28)' }}
            labelStyle={{ color: 'var(--color-ink-muted)', fontSize: 12 }}
            itemStyle={{ color: 'var(--color-ink)' }}
            labelFormatter={(v) => format(v as number, 'PPp')}
            formatter={(value) => [Number(value).toLocaleString(), 'Views']}
          />
          <Bar dataKey="views" fill="url(#views-bar)" radius={[4, 4, 0, 0]} maxBarSize={44}>
            {/* Highlight the peak post so the best performer reads at a glance. */}
            {data.map((d, i) => (
              <Cell key={i} fillOpacity={peak > 0 && d.views === peak ? 1 : 0.82} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
