import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Segmented } from './form';
import { cn } from '@/lib/utils';

// Small, chart-free figures for dashboards, following the data-viz method: a thin segmented bar beside its figures,
// a meter on a same-hue track, ranked bars in one hue with the value at the tip, and a chart card whose table view
// gives every value without hovering. Marks use the --chart-* colours; text stays in ink (fg / muted).

export interface Part {
  key: string;
  label: string;
  value: number;
  color: string;
}

/**
 * One whole split into parts: an 8px bar (no text on it) above a legend that names each part and gives its figure.
 * Parts at zero draw nothing; each part keeps a 2px surface gap from its neighbour.
 */
export function SplitBar({ parts, label, format = String }: { parts: Part[]; label: string; format?: (n: number) => string }) {
  const total = parts.reduce((a, p) => a + Math.max(p.value, 0), 0);
  const shown = parts.filter((p) => p.value > 0);
  return (
    <div>
      <div role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${format(p.value)}`).join(', ')}`} className="flex h-2 w-full gap-[2px] overflow-hidden rounded-full bg-surface-3">
        {total > 0 && shown.map((p) => <span key={p.key} title={`${p.label}: ${format(p.value)}`} className="h-full first:rounded-l-full last:rounded-r-full" style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />)}
      </div>
      <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {parts.map((p) => (
          <li key={p.key} className="inline-flex items-center gap-1.5 text-muted">
            <span aria-hidden className="size-2.5 rounded-[3px]" style={{ background: p.color }} />
            {p.label} <span className="font-semibold text-fg">{format(p.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A single ratio against its whole: accent fill on a lighter track of the same hue. */
export function Meter({ value, max = 100, label }: { value: number; max?: number; label: string }) {
  const pct = max > 0 ? Math.min(Math.max(value / max, 0), 1) * 100 : 0;
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className="h-2 w-full overflow-hidden rounded-full" style={{ background: 'var(--chart-accent-track)' }}>
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: 'var(--chart-accent)' }} />
    </div>
  );
}

/** Ranked horizontal bars in one hue, largest first: name and value on top, the bar beneath (square at the start). */
export function RankedBars({ rows, format = String, empty }: { rows: Array<{ key: string; label: ReactNode; value: number; note?: ReactNode; to?: string }>; format?: (n: number) => string; empty?: ReactNode }) {
  const max = Math.max(...rows.map((r) => r.value), 0);
  if (rows.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ol className="space-y-3">
      {rows.map((r) => {
        const inner = (
          <>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate font-medium text-fg">{r.label}</span>
              <span className="shrink-0 font-semibold tabular-nums text-fg">{format(r.value)}</span>
            </div>
            <div className="mt-1 h-2.5 w-full" aria-hidden>
              <div className="h-full rounded-r" style={{ width: `${max > 0 ? Math.max((r.value / max) * 100, 1) : 0}%`, background: 'var(--chart-accent)' }} />
            </div>
            {r.note && <p className="mt-0.5 text-xs text-muted">{r.note}</p>}
          </>
        );
        return <li key={r.key}>{r.to ? <Link to={r.to} className="block rounded-md hover:bg-surface-2 focus-visible:bg-surface-2">{inner}</Link> : inner}</li>;
      })}
    </ol>
  );
}

/** A chart in a card, with a Chart / Table switch so every value is readable without hovering. */
export function ChartCard({ title, description, heading, link, chart, table, className }: { title: string; description?: ReactNode; heading?: ReactNode; link?: { to: string; label: string }; chart: ReactNode; table: { columns: string[]; rows: Array<Array<ReactNode>> }; className?: string }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <section aria-label={title} className={cn('rounded-card border border-line bg-surface p-4 shadow-card md:p-5', className)}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        {heading ?? (
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-fg">{title}</h3>
            {description && <p className="text-sm text-muted">{description}</p>}
          </div>
        )}
        <div className="flex items-center gap-3">
          {link && <Link to={link.to} className="text-sm font-medium text-primary hover:underline">{link.label}</Link>}
          <Segmented size="sm" label={`Show ${title.toLowerCase()} as`} value={view} onChange={setView} options={[{ value: 'chart', label: 'Chart' }, { value: 'table', label: 'Table' }]} />
        </div>
      </div>
      {view === 'chart' ? chart : (
        <div className="scroll-thin max-h-64 overflow-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-2"><tr>{table.columns.map((c, i) => <th key={c} className={cn('px-3 py-2 text-xs font-medium text-muted', i === 0 ? 'text-left' : 'text-right')}>{c}</th>)}</tr></thead>
            <tbody>{table.rows.map((r, i) => <tr key={i} className="border-t border-line">{r.map((cell, j) => <td key={j} className={cn('px-3 py-1.5 tabular-nums', j === 0 ? 'text-left text-muted' : 'text-right')}>{cell}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** A dashboard section: a short title and the one-sentence takeaway the numbers below support. */
export function StorySection({ title, story, children, id }: { title: string; story?: ReactNode; children: ReactNode; id: string }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div>
        <h2 id={id} className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h2>
        {story && <p className="mt-0.5 text-base text-fg">{story}</p>}
      </div>
      {children}
    </section>
  );
}
