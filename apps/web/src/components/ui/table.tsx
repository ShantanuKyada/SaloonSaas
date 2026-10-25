import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { EmptyState, ErrorState, Skeleton } from './display';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
  /** How the column appears in the phone card layout. */
  mobile?: 'title' | 'meta' | 'hide';
  hideBelow?: 'md' | 'lg';
  srOnlyHeader?: boolean;
}

export interface PaginationState {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}

export function Pagination({ page, pageSize, total, onPageChange }: PaginationState) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  if (total <= pageSize) return total ? <p className="px-4 py-3 text-xs text-muted">{total} {total === 1 ? 'result' : 'results'}</p> : null;
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
      <p className="text-xs text-muted">
        Showing {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
      </p>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" onClick={() => onPageChange(page - 1)} disabled={page <= 1} aria-label="Previous page" icon={<ChevronLeft className="size-4" />}>
          Previous
        </Button>
        <span className="px-2 text-xs text-muted" aria-current="page">
          Page {page} of {pages}
        </span>
        <Button variant="outline" size="sm" onClick={() => onPageChange(page + 1)} disabled={page >= pages} aria-label="Next page">
          Next
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </nav>
  );
}

interface DataTableProps<T> {
  columns: Array<Column<T>>;
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  loading?: boolean;
  loadingLabel?: string;
  error?: unknown;
  onRetry?: () => void;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  pagination?: PaginationState;
  caption?: string;
  rowClassName?: (row: T) => string | undefined;
  footer?: ReactNode;
}

const hide = { md: 'max-md:hidden', lg: 'max-lg:hidden' } as const;

/** A real table on larger screens and tidy cards on phones (not a shrunk desktop table). */
export function DataTable<T>({ columns, rows, rowKey, loading, loadingLabel = 'Loading…', error, onRetry, empty, onRowClick, pagination, caption, rowClassName, footer }: DataTableProps<T>) {
  if (error) return <ErrorState error={error} onRetry={onRetry} compact />;
  if (loading && !rows) {
    return (
      <div role="status" aria-label={loadingLabel} className="space-y-2 p-4">
        <span className="sr-only">{loadingLabel}</span>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-11" />
        ))}
      </div>
    );
  }
  if (!rows || rows.length === 0) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;

  const title = columns.find((c) => c.mobile === 'title') ?? columns[0]!;
  const meta = columns.filter((c) => c !== title && c.mobile !== 'hide');
  return (
    <div className={cn(loading && 'opacity-60 transition-opacity')} aria-busy={loading || undefined}>
      <div className="max-md:hidden">
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full text-sm">
            {caption && <caption className="sr-only">{caption}</caption>}
            <thead>
              <tr className="border-b border-line text-left text-xs font-medium uppercase tracking-wide text-muted">
                {columns.map((c) => (
                  <th key={c.key} scope="col" className={cn('px-4 py-2.5 font-medium', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center', c.hideBelow && hide[c.hideBelow], c.className)}>
                    {c.srOnlyHeader ? <span className="sr-only">{c.header}</span> : c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={onRowClick ? (e) => (e.key === 'Enter' ? onRowClick(row) : undefined) : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  className={cn('border-b border-line last:border-0', onRowClick && 'cursor-pointer hover:bg-surface-2 focus-visible:bg-surface-2', rowClassName?.(row))}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={cn('px-4 py-3 align-middle', c.align === 'right' && 'text-right tabular-nums', c.align === 'center' && 'text-center', c.hideBelow && hide[c.hideBelow], c.className)}>
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <ul className="divide-y divide-line md:hidden">
        {rows.map((row) => (
          <li key={rowKey(row)}>
            <div onClick={onRowClick ? () => onRowClick(row) : undefined} role={onRowClick ? 'button' : undefined} tabIndex={onRowClick ? 0 : undefined} className={cn('space-y-1.5 px-4 py-3', onRowClick && 'active:bg-surface-2', rowClassName?.(row))}>
              <div className="font-medium text-fg">{title.cell(row)}</div>
              {meta.map((c) => (
                <div key={c.key} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="shrink-0 text-xs text-muted">{c.header}</span>
                  <span className="min-w-0 text-right text-fg">{c.cell(row)}</span>
                </div>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {footer}
      {pagination && <Pagination {...pagination} />}
    </div>
  );
}
