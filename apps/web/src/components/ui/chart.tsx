import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

// Charts only where they communicate a trend. Colours are CSS variables, so they follow light/dark mode.

export const CHART_COLORS = ['var(--primary)', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

export interface Series {
  key: string;
  label: string;
  color?: string;
}

const axisProps = { stroke: 'var(--faint)', fontSize: 12, tickLine: false, axisLine: false } as const;

function tooltipStyle() {
  return { background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 10, color: 'var(--fg)', fontSize: 13, boxShadow: 'var(--shadow-lg)' };
}

export function TrendChart({ data, xKey, series, format, height = 240, xFormat }: { data: Array<Record<string, string | number>>; xKey: string; series: Series[]; format?: (n: number) => string; height?: number; xFormat?: (v: string) => string }) {
  return (
    <div style={{ height }} role="img" aria-label={`Trend of ${series.map((s) => s.label).join(', ')}`}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            {series.map((s, i) => (
              <linearGradient key={s.key} id={`fill-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={s.color ?? CHART_COLORS[i % CHART_COLORS.length]} stopOpacity={0.3} />
                <stop offset="95%" stopColor={s.color ?? CHART_COLORS[i % CHART_COLORS.length]} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey={xKey} {...axisProps} tickFormatter={xFormat} minTickGap={24} />
          <YAxis {...axisProps} width={56} tickFormatter={(v: number) => (format ? format(v) : String(v))} />
          <Tooltip contentStyle={tooltipStyle()} formatter={(v) => (format ? format(Number(v)) : String(v))} labelFormatter={(l) => (xFormat ? xFormat(String(l)) : String(l))} />
          {series.length > 1 && <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />}
          {series.map((s, i) => (
            <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color ?? CHART_COLORS[i % CHART_COLORS.length]} strokeWidth={2} fill={`url(#fill-${s.key})`} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Bars({ data, xKey, series, format, height = 240, stacked, xFormat }: { data: Array<Record<string, string | number>>; xKey: string; series: Series[]; format?: (n: number) => string; height?: number; stacked?: boolean; xFormat?: (v: string) => string }) {
  return (
    <div style={{ height }} role="img" aria-label={`Comparison of ${series.map((s) => s.label).join(', ')}`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey={xKey} {...axisProps} tickFormatter={xFormat} minTickGap={16} />
          <YAxis {...axisProps} width={56} tickFormatter={(v: number) => (format ? format(v) : String(v))} />
          <Tooltip cursor={{ fill: 'var(--surface-2)' }} contentStyle={tooltipStyle()} formatter={(v) => (format ? format(Number(v)) : String(v))} labelFormatter={(l) => (xFormat ? xFormat(String(l)) : String(l))} />
          {series.length > 1 && <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />}
          {series.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} stackId={stacked ? 'a' : undefined} fill={s.color ?? CHART_COLORS[i % CHART_COLORS.length]} radius={stacked ? 0 : [4, 4, 0, 0]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
