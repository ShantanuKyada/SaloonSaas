import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

// Charts only where they communicate a trend. Colours are CSS variables, so they follow light/dark mode. The look
// follows the data-viz method: hairline solid grid, thin marks, a light wash under lines, a legend only for two or more
// series (its text in ink, never in the series colour), a crosshair on lines and a hover state on bars.

export const CHART_COLORS = ['var(--chart-accent)', 'var(--chart-good)', 'var(--chart-muted)', 'var(--chart-critical)'];

export interface Series {
  key: string;
  label: string;
  color?: string;
}

const axisProps = { stroke: 'var(--muted)', fontSize: 12, tickLine: false, axisLine: false } as const;
const legendProps = {
  verticalAlign: 'top' as const,
  align: 'left' as const,
  height: 28,
  itemSorter: null, // keep the series order (the stacking order), not alphabetical
  wrapperStyle: { fontSize: 12 },
  formatter: (value: string) => <span style={{ color: 'var(--muted)' }}>{value}</span>,
};

function tooltipProps(format?: (n: number) => string, xFormat?: (v: string) => string) {
  return {
    contentStyle: { background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 10, fontSize: 13, boxShadow: 'var(--shadow-lg)' },
    labelStyle: { color: 'var(--muted)', marginBottom: 2 },
    itemStyle: { color: 'var(--fg)', fontWeight: 600, padding: 0 },
    formatter: (v: unknown) => (format ? format(Number(v)) : String(v)),
    labelFormatter: (l: unknown) => (xFormat ? xFormat(String(l)) : String(l)),
  };
}

/** A short axis label: 1,200 → 1.2K, 3,40,000 → 3.4L (or 340K), keeping a currency symbol when given. */
export function compactAxis(symbol = '', locale = 'en-IN') {
  const f = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
  return (v: number) => `${symbol}${f.format(v)}`;
}

export function TrendChart({ data, xKey, series, format, axisFormat, height = 240, xFormat }: { data: Array<Record<string, string | number>>; xKey: string; series: Series[]; format?: (n: number) => string; axisFormat?: (n: number) => string; height?: number; xFormat?: (v: string) => string }) {
  return (
    <div style={{ height }} role="img" aria-label={`Trend of ${series.map((s) => s.label).join(', ')}`}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--line)" vertical={false} />
          <XAxis dataKey={xKey} {...axisProps} tickFormatter={xFormat} minTickGap={24} />
          <YAxis {...axisProps} width={56} tickFormatter={(v: number) => (axisFormat ?? format)?.(v) ?? String(v)} />
          <Tooltip {...tooltipProps(format, xFormat)} cursor={{ stroke: 'var(--line-strong)', strokeWidth: 1 }} />
          {series.length > 1 && <Legend {...legendProps} iconType="plainline" />}
          {series.map((s, i) => {
            const color = s.color ?? CHART_COLORS[i % CHART_COLORS.length];
            return <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={color} strokeWidth={2} fill={color} fillOpacity={0.1} activeDot={{ r: 5, stroke: 'var(--surface)', strokeWidth: 2, fill: color }} />;
          })}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Bars({ data, xKey, series, format, axisFormat, height = 240, stacked, xFormat }: { data: Array<Record<string, string | number>>; xKey: string; series: Series[]; format?: (n: number) => string; axisFormat?: (n: number) => string; height?: number; stacked?: boolean; xFormat?: (v: string) => string }) {
  return (
    <div style={{ height }} role="img" aria-label={`Comparison of ${series.map((s) => s.label).join(', ')}`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2}>
          <CartesianGrid stroke="var(--line)" vertical={false} />
          <XAxis dataKey={xKey} {...axisProps} tickFormatter={xFormat} minTickGap={16} />
          <YAxis {...axisProps} width={56} allowDecimals={false} tickFormatter={(v: number) => (axisFormat ?? format)?.(v) ?? String(v)} />
          <Tooltip {...tooltipProps(format, xFormat)} cursor={{ fill: 'var(--surface-2)' }} />
          {series.length > 1 && <Legend {...legendProps} iconType="square" />}
          {series.map((s, i) => {
            const color = s.color ?? CHART_COLORS[i % CHART_COLORS.length];
            // Rounded at the data end only; stacked segments are separated by a 2px gap in the surface colour.
            const top = !stacked || i === series.length - 1;
            return <Bar key={s.key} dataKey={s.key} name={s.label} stackId={stacked ? 'a' : undefined} fill={color} maxBarSize={24} radius={top ? [4, 4, 0, 0] : 0} stroke={stacked ? 'var(--surface)' : undefined} strokeWidth={stacked ? 2 : 0} />;
          })}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
