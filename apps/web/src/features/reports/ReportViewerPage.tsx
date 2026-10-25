import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS } from '@salon/shared';
import { useQuery } from '@tanstack/react-query';
import { Download, Printer } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { toastError } from '@/app/providers';
import { CustomerPicker } from '@/components/common/CustomerPicker';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, ErrorState, InlineNotice, PageHeader, Skeleton } from '@/components/ui/display';
import { DateInput, Field, Input, Segmented, Select } from '@/components/ui/form';
import { Pagination } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useBranch } from '@/lib/branch';
import { dateRangePreset, fmtDay, fmtDateTime, money, PRESET_LABELS, todayIn } from '@/lib/format';
import { useServices, useStaffList } from '@/lib/queries';
import { cn } from '@/lib/utils';

type ColumnType = 'text' | 'number' | 'money' | 'percent' | 'date' | 'datetime' | 'minutes';
interface ReportData {
  key: string;
  title: string;
  description: string;
  columns: Array<{ key: string; label: string; type: ColumnType }>;
  rows: Array<Record<string, unknown>>;
  totals: Record<string, unknown> | null;
  note: string | null;
  params: { from: string; to: string; branchId: string | null; groupBy: string };
  currency: string;
  generatedAt: string;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

const GROUPABLE = new Set(['appointments-daily', 'revenue-daily', 'finance-collections', 'customers-new']);
const WITH_STAFF = new Set(['appointments-daily', 'appointments-staff', 'appointments-cancellations', 'appointments-no-shows', 'revenue-daily', 'revenue-services', 'revenue-staff', 'staff-services', 'staff-revenue', 'staff-utilization', 'staff-attendance']);
const WITH_SERVICE = new Set(['appointments-daily', 'appointments-cancellations', 'appointments-no-shows', 'revenue-daily', 'revenue-services', 'revenue-staff', 'staff-services']);
const WITH_CUSTOMER = new Set(['finance-ledger', 'appointments-daily', 'revenue-daily']);
const WITH_METHOD = new Set(['finance-collections', 'finance-collection-details']);

function cell(type: ColumnType, value: unknown, currency: string, tz: string): string {
  if (value === null || value === undefined || value === '') return '—';
  switch (type) {
    case 'money': return money(Number(value), currency);
    case 'number': return Number(value).toLocaleString('en-IN', { maximumFractionDigits: 1 });
    case 'percent': return `${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 1 })}%`;
    case 'minutes': return `${Number(value)} min`;
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? fmtDay(String(value), tz, true) : String(value);
    case 'datetime': return fmtDateTime(String(value), tz);
    default: return String(value);
  }
}

export function Component() {
  const { key } = useParams();
  const [params, setParams] = useSearchParams();
  const { branches, scopeBranchId, timezone } = useBranch();
  const today = todayIn(timezone);
  const monthRange = dateRangePreset('month', today);
  const from = params.get('from') ?? monthRange.from;
  const to = params.get('to') ?? monthRange.to;
  const get = (name: string) => params.get(name) ?? '';
  const page = Number(params.get('page') ?? 1) || 1;
  const reportBranch = params.get('branchId') ?? scopeBranchId ?? '';
  const [exporting, setExporting] = useState(false);
  const staff = useStaffList(reportBranch || undefined, { bookableOnly: false, status: 'all' });
  const services = useServices(reportBranch || undefined, { includeInactive: true });

  const set = (patch: Record<string, string | null>, resetPage = true) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    if (resetPage) next.delete('page');
    setParams(next, { replace: true });
  };
  const query = {
    from, to, page, pageSize: 50,
    branchId: reportBranch || undefined,
    staffId: get('staffId') || undefined,
    serviceId: get('serviceId') || undefined,
    customerId: get('customerId') || undefined,
    method: get('method') || undefined,
    groupBy: get('groupBy') || undefined,
    inactiveDays: get('inactiveDays') || undefined,
    collectionType: get('collectionType') || undefined,
  };
  const q = useQuery({ queryKey: ['report', key, query], queryFn: () => api.get<ReportData>(`/reports/${key}`, query), enabled: !!key && from <= to, placeholderData: (prev) => prev });
  const data = q.data;
  const activePreset = (['today', 'yesterday', 'week', 'month', 'lastMonth'] as const).find((p) => { const r = dateRangePreset(p, today); return r.from === from && r.to === to; });

  const exportCsv = async () => {
    setExporting(true);
    try { await api.download(`/reports/${key}`, { ...query, page: undefined, pageSize: undefined, format: 'csv' }); } catch (e) { toastError(e); } finally { setExporting(false); }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        back={<Link to="/reports" className="no-print mb-1 inline-block text-sm text-muted hover:text-fg">← All reports</Link>}
        title={data?.title ?? 'Report'}
        description={data?.description}
        actions={<span className="no-print flex gap-2"><Button variant="outline" icon={<Printer className="size-4" />} onClick={() => window.print()} disabled={!data}>Print</Button><Button icon={<Download className="size-4" />} loading={exporting} onClick={() => void exportCsv()} disabled={!data}>Download for Excel</Button></span>}
      />
      <Card className="no-print">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick date ranges">
            {(Object.keys(PRESET_LABELS) as Array<keyof typeof PRESET_LABELS>).map((p) => <Button key={p} size="sm" variant={activePreset === p ? 'soft' : 'ghost'} aria-pressed={activePreset === p} onClick={() => { const r = dateRangePreset(p, today); set({ from: r.from, to: r.to }); }}>{PRESET_LABELS[p]}</Button>)}
          </div>
          <Field label="From"><DateInput value={from} max={to} onChange={(e) => e.target.value && set({ from: e.target.value })} className="w-44" /></Field>
          <Field label="To"><DateInput value={to} min={from} onChange={(e) => e.target.value && set({ to: e.target.value })} className="w-44" /></Field>
          {branches.length > 1 && <Field label="Branch"><Select value={reportBranch} onChange={(e) => set({ branchId: e.target.value || null })} className="w-44"><option value="">All branches</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>}
          {key && WITH_STAFF.has(key) && <Field label="Team member"><Select value={get('staffId')} onChange={(e) => set({ staffId: e.target.value || null })} className="w-44"><option value="">Everyone</option>{(staff.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.displayName}</option>)}</Select></Field>}
          {key && WITH_SERVICE.has(key) && <Field label="Service"><Select value={get('serviceId')} onChange={(e) => set({ serviceId: e.target.value || null })} className="w-44"><option value="">All services</option>{(services.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>}
          {key && WITH_METHOD.has(key) && <Field label="Paid by"><Select value={get('method')} onChange={(e) => set({ method: e.target.value || null })} className="w-40"><option value="">Any method</option>{PAYMENT_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}</Select></Field>}
          {key === 'finance-collections' && <Field label="Show"><Select value={get('collectionType') || 'all'} onChange={(e) => set({ collectionType: e.target.value === 'all' ? null : e.target.value })} className="w-52"><option value="all">All payments</option><option value="sale">Payments for new bills</option><option value="credit_settlement">Old pending amounts collected</option><option value="advance">Advances</option></Select></Field>}
          {key === 'customers-inactive' && <Field label="Not seen for at least"><Input type="number" min={1} suffix="days" value={get('inactiveDays') || 60} onChange={(e) => set({ inactiveDays: e.target.value })} className="w-36" /></Field>}
          {key && GROUPABLE.has(key) && <Segmented label="Group by" size="sm" value={(get('groupBy') || 'day') as 'day' | 'week' | 'month'} onChange={(v) => set({ groupBy: v === 'day' ? null : v })} options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} />}
        </div>
        {key && WITH_CUSTOMER.has(key) && (
          <div className="mt-4 max-w-md"><CustomerPicker value={get('customerId') || null} label={key === 'finance-ledger' ? 'Customer (required)' : 'Customer (optional)'} onChange={(c) => set({ customerId: c?.id ?? null })} /></div>
        )}
      </Card>

      {from > to && <InlineNotice tone="warning">“From” is after “To”. Swap the dates to see results.</InlineNotice>}
      {q.isLoading && <div role="status" aria-label="Running report" className="space-y-2"><Skeleton className="h-10" /><Skeleton className="h-64" /></div>}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {data && (
        <Card padded={false} className={cn('print-area', q.isFetching && 'opacity-70 transition-opacity')}>
          <div className="border-b border-line px-4 py-3 text-sm text-muted">
            {fmtDay(data.params.from, timezone, true)} – {fmtDay(data.params.to, timezone, true)} · {data.total.toLocaleString('en-IN')} {data.total === 1 ? 'row' : 'rows'}
            <span className="print-only"> · Printed {fmtDateTime(new Date().toISOString(), timezone)}</span>
          </div>
          {data.note && <p className="border-b border-line bg-info-soft px-4 py-2 text-sm text-info">{data.note}</p>}
          {data.rows.length === 0 ? <EmptyState title="Nothing to show" description="No records match these filters. Try a wider date range or fewer filters." /> : (
            <div className="scroll-thin overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">{data.columns.map((c) => <th key={c.key} scope="col" className={cn('whitespace-nowrap px-4 py-2.5 font-medium', ['money', 'number', 'percent', 'minutes'].includes(c.type) && 'text-right')}>{c.label}</th>)}</tr></thead>
                <tbody>
                  {data.rows.map((row, i) => (
                    <tr key={i} className="border-b border-line last:border-0 hover:bg-surface-2/50">
                      {data.columns.map((c) => <td key={c.key} className={cn('px-4 py-2', ['money', 'number', 'percent', 'minutes'].includes(c.type) && 'text-right tabular-nums', c.type === 'datetime' && 'whitespace-nowrap')}>{cell(c.type, row[c.key], data.currency, timezone)}</td>)}
                    </tr>
                  ))}
                </tbody>
                {data.totals && <tfoot><tr className="border-t-2 border-line bg-surface-2/60 font-semibold">{data.columns.map((c) => <td key={c.key} className={cn('px-4 py-2.5', ['money', 'number', 'percent', 'minutes'].includes(c.type) && 'text-right tabular-nums')}>{data.totals![c.key] === undefined ? '' : cell(c.type, data.totals![c.key], data.currency, timezone)}</td>)}</tr></tfoot>}
              </table>
            </div>
          )}
          {data.rows.length < data.total && <div className="no-print"><Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={(p) => set({ page: String(p) }, false)} /></div>}
        </Card>
      )}
    </div>
  );
}
