import { AGEING_BUCKETS, type OutstandingCustomerRow } from '@salon/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Download, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { toastError } from '@/app/providers';
import { Money, useMoney } from '@/components/common/badges';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, EmptyState, PageHeader, StatCard } from '@/components/ui/display';
import { Bars } from '@/components/ui/chart';
import { Field, SearchInput, Select } from '@/components/ui/form';
import { DataTable, type Column } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { relativeDays, todayIn } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';

interface Summary {
  asOf: string;
  totalOutstanding: number;
  overdueOutstanding: number;
  customersWithOutstanding: number;
  openInvoices: number;
  advanceHeld: number;
  ageing: Array<{ key: string; label: string; amount: number }>;
  byBranch: Array<{ branchId: string; branchName: string; outstanding: number; customers: number }>;
}

export function Component() {
  const can = useCan();
  const money = useMoney();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { scopeBranchId, timezone } = useBranch();
  const [params, setParams] = useSearchParams();
  const bucket = params.get('bucket') ?? '';
  const page = Number(params.get('page') ?? 1);
  const [text, setText] = useState('');
  const search = useDebounced(text.trim(), 300);
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v === null || v === '' ? next.delete(k) : next.set(k, v));
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  const summary = useQuery({ queryKey: ['outstanding', 'summary', scopeBranchId], queryFn: () => api.get<Summary>('/outstanding/summary', { branchId: scopeBranchId }) });
  const query = { branchId: scopeBranchId, bucket: bucket || undefined, search: search || undefined, page, pageSize: 25 };
  const list = useQuery({ queryKey: ['outstanding', 'customers', query], queryFn: () => api.list<OutstandingCustomerRow>('/outstanding/customers', query), placeholderData: (p) => p });
  const remind = useMutation({
    mutationFn: (customerId: string) => api.post<{ queued: number }>('/outstanding/remind', { customerId }),
    onSuccess: () => { toast.success('Reminder queued', { description: 'It goes out by WhatsApp or email, depending on what the customer has agreed to.' }); void client.invalidateQueries({ queryKey: ['outstanding', 'customers'] }); },
    onError: toastError,
  });

  const columns: Array<Column<OutstandingCustomerRow>> = [
    { key: 'name', header: 'Customer', mobile: 'title', cell: (r) => <div><p className="font-medium">{r.fullName}</p><p className="text-xs text-muted">{r.customerCode}{r.mobile ? ` · ${r.mobile}` : ''}</p></div> },
    ...AGEING_BUCKETS.map((b) => ({ key: b.key, header: b.label, align: 'right' as const, hideBelow: 'lg' as const, mobile: 'hide' as const, cell: (r: OutstandingCustomerRow) => (r.buckets[b.key] > 0 ? <Money value={r.buckets[b.key]} className={b.key === 'd90_plus' || b.key === 'd61_90' ? 'font-semibold text-danger' : ''} /> : <span className="text-faint">—</span>) })),
    { key: 'total', header: 'Pending', align: 'right', cell: (r) => <Money value={r.outstanding} className="font-semibold" /> },
    { key: 'oldest', header: 'Oldest bill', hideBelow: 'md', cell: (r) => relativeDays(r.oldestInvoiceDate ? `${r.oldestInvoiceDate}T12:00:00Z` : null) },
    { key: 'last', header: 'Last reminder', hideBelow: 'lg', cell: (r) => (r.lastReminderAt ? relativeDays(r.lastReminderAt) : <span className="text-faint">Never</span>) },
    {
      key: 'actions',
      header: 'Actions',
      srOnlyHeader: true,
      mobile: 'hide',
      align: 'right',
      cell: (r) => (
        <span className="flex justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
          {can('payments.collect') && <Button size="sm" icon={<Wallet className="size-4" />} onClick={() => navigate(`/billing/collect?customerId=${r.customerId}`)}>Collect</Button>}
          {can('payments.collect') && <Button size="sm" variant="outline" icon={<BellRing className="size-4" />} loading={remind.isPending && remind.variables === r.customerId} onClick={() => remind.mutate(r.customerId)}>Remind</Button>}
        </span>
      ),
    },
  ];

  const s = summary.data;
  return (
    <div className="space-y-5">
      <PageHeader title="Pending payments" description={`Who owes what, as of ${s ? s.asOf : todayIn(timezone)}.`} actions={can('reports.financial') && <Button variant="outline" icon={<Download className="size-4" />} onClick={() => void api.download('/reports/finance-outstanding', { from: todayIn(timezone), to: todayIn(timezone), format: 'csv', branchId: scopeBranchId })}>Export</Button>} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total pending" value={s ? money(s.totalOutstanding) : '…'} loading={!s} tone="warning" />
        <StatCard label="Past the due date" value={s ? money(s.overdueOutstanding) : '…'} loading={!s} tone={s && s.overdueOutstanding > 0 ? 'danger' : 'neutral'} />
        <StatCard label="Customers who owe" value={s?.customersWithOutstanding ?? '…'} loading={!s} hint={s ? `${s.openInvoices} bills` : undefined} />
        <StatCard label="Advance held" value={s ? money(s.advanceHeld) : '…'} loading={!s} hint="Paid ahead by customers" />
      </div>
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader title="How old are the pending bills?" description="Click a bar to see only those customers." />
          {s && <div className="cursor-pointer"><Bars data={s.ageing.map((a) => ({ bucket: a.label, amount: a.amount }))} xKey="bucket" series={[{ key: 'amount', label: 'Pending', color: 'var(--warning)' }]} format={(v) => money(v)} height={200} /></div>}
          <div className="mt-3 flex flex-wrap gap-2">{AGEING_BUCKETS.map((b) => <Button key={b.key} size="sm" variant={bucket === b.key ? 'primary' : 'outline'} onClick={() => set({ bucket: bucket === b.key ? null : b.key })}>{b.label}{s ? `: ${money(s.ageing.find((a) => a.key === b.key)?.amount ?? 0)}` : ''}</Button>)}</div>
        </Card>
        {s && s.byBranch.length > 1 && (
          <Card><CardHeader title="By branch" /><ul className="space-y-2 text-sm">{s.byBranch.map((b) => <li key={b.branchId} className="flex justify-between"><span>{b.branchName}<span className="block text-xs text-muted">{b.customers} customers</span></span><Money value={b.outstanding} className="font-semibold" /></li>)}</ul></Card>
        )}
      </div>
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <SearchInput className="min-w-60 flex-1" value={text} onChange={setText} placeholder="Search customer" />
          <Field label="Age" className="sr-only"><Select value={bucket} onChange={(e) => set({ bucket: e.target.value })}><option value="">All ages</option>{AGEING_BUCKETS.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}</Select></Field>
        </div>
        <DataTable columns={columns} rows={list.data?.rows} rowKey={(r) => r.customerId} loading={list.isLoading || list.isFetching} loadingLabel="Loading pending payments…" error={list.isError ? list.error : undefined} onRetry={() => void list.refetch()} onRowClick={(r) => navigate(`/billing/ledger?customerId=${r.customerId}`)} pagination={list.data ? { page, pageSize: 25, total: list.data.meta.total, onPageChange: (p) => set({ page: String(p) }) } : undefined} empty={<EmptyState title="No pending payments" description="Everyone is paid up." />} />
      </Card>
    </div>
  );
}
