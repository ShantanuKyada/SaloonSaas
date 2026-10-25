import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS, type InvoiceSummary, type PaymentSummary } from '@salon/shared';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Money, PaymentBadge } from '@/components/common/badges';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui/display';
import { DateInput, Field, SearchInput, Segmented, Select } from '@/components/ui/form';
import { DataTable, type Column } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { dateRangePreset, fmtDateTime, fmtDay, PRESET_LABELS, todayIn } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';

type Preset = keyof typeof PRESET_LABELS | 'all' | 'custom';

function useRange() {
  const { timezone } = useBranch();
  const [params, setParams] = useSearchParams();
  const today = todayIn(timezone);
  const preset = (params.get('range') ?? 'month') as Preset;
  const custom = { from: params.get('from') ?? today, to: params.get('to') ?? today };
  const range = preset === 'all' ? { from: undefined, to: undefined } : preset === 'custom' ? custom : dateRangePreset(preset, today);
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v === null || v === '' ? next.delete(k) : next.set(k, v));
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };
  return { params, set, preset, range, custom, page: Number(params.get('page') ?? 1) };
}

function RangeControls({ r }: { r: ReturnType<typeof useRange> }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented label="Date range" value={r.preset} onChange={(v) => r.set({ range: v })} options={[...(Object.keys(PRESET_LABELS) as Array<keyof typeof PRESET_LABELS>).map((k) => ({ value: k as Preset, label: PRESET_LABELS[k] })), { value: 'custom' as Preset, label: 'Pick dates' }, { value: 'all' as Preset, label: 'All' }]} />
      {r.preset === 'custom' && <><DateInput aria-label="From" className="w-40" value={r.custom.from} onChange={(e) => r.set({ from: e.target.value })} /><DateInput aria-label="To" className="w-40" value={r.custom.to} onChange={(e) => r.set({ to: e.target.value })} /></>}
    </div>
  );
}

export function Component() {
  const can = useCan();
  const navigate = useNavigate();
  const { scopeBranchId, timezone } = useBranch();
  const r = useRange();
  const status = r.params.get('status') ?? '';
  const [text, setText] = useState(r.params.get('q') ?? '');
  const search = useDebounced(text.trim(), 300);
  const query = { branchId: scopeBranchId, from: r.range.from, to: r.range.to, paymentStatus: status || undefined, search: search || undefined, page: r.page, pageSize: 25 };
  const list = useQuery({ queryKey: ['bills', query], queryFn: () => api.list<InvoiceSummary>('/billing/invoices', query), placeholderData: (p) => p });

  const columns: Array<Column<InvoiceSummary>> = [
    { key: 'no', header: 'Bill', mobile: 'title', cell: (i) => <div><p className="font-medium">{i.invoiceNumber}</p><p className="text-xs text-muted">{fmtDay(i.invoiceDate, timezone)}</p></div> },
    { key: 'customer', header: 'Customer', cell: (i) => i.customerName },
    { key: 'branch', header: 'Branch', hideBelow: 'lg', cell: (i) => i.branchName },
    { key: 'total', header: 'Total', align: 'right', cell: (i) => <Money value={i.grandTotal} /> },
    { key: 'paid', header: 'Paid', align: 'right', hideBelow: 'md', cell: (i) => <Money value={i.amountPaid} muted /> },
    { key: 'due', header: 'Pending', align: 'right', cell: (i) => (i.balanceDue > 0 ? <Money value={i.balanceDue} className="font-semibold text-warning" /> : <span className="text-faint">—</span>) },
    { key: 'status', header: 'Status', cell: (i) => <PaymentBadge status={i.paymentStatus} /> },
  ];

  return (
    <div>
      <PageHeader title="Bills" actions={can('billing.create') && <Button icon={<Plus className="size-4" />} hotkey="B" onClick={() => navigate('/billing/new')}>New bill</Button>} />
      <Card padded={false}>
        <div className="space-y-3 border-b border-line p-4">
          <RangeControls r={r} />
          <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
            <SearchInput value={text} onChange={(v) => { setText(v); r.set({ q: v.trim() || null }); }} placeholder="Bill number, customer name or mobile" />
            <Field label="Status" className="sr-only"><Select value={status} onChange={(e) => r.set({ status: e.target.value })}><option value="">All bills</option><option value="unpaid">Pending payment</option><option value="partial">Partly paid</option><option value="paid">Paid</option><option value="void">Cancelled</option></Select></Field>
          </div>
        </div>
        <DataTable columns={columns} rows={list.data?.rows} rowKey={(i) => i.id} loading={list.isLoading || list.isFetching} loadingLabel="Loading bills…" error={list.isError ? list.error : undefined} onRetry={() => void list.refetch()} onRowClick={(i) => navigate(`/billing/bills/${i.id}`)} pagination={list.data ? { page: r.page, pageSize: 25, total: list.data.meta.total, onPageChange: (p) => r.set({ page: String(p) }) } : undefined} empty={<EmptyState title="No bills in this period" description="Bills appear here as soon as they are created." action={can('billing.create') && <Button onClick={() => navigate('/billing/new')}>New bill</Button>} />} />
      </Card>
    </div>
  );
}

export function PaymentsComponent() {
  const navigate = useNavigate();
  const { scopeBranchId, timezone } = useBranch();
  const r = useRange();
  const method = r.params.get('method') ?? '';
  const [text, setText] = useState(r.params.get('q') ?? '');
  const search = useDebounced(text.trim(), 300);
  const query = { branchId: scopeBranchId, from: r.range.from, to: r.range.to, method: method || undefined, search: search || undefined, page: r.page, pageSize: 25 };
  const list = useQuery({ queryKey: ['payments', query], queryFn: () => api.list<PaymentSummary>('/payments', query), placeholderData: (p) => p });
  const columns: Array<Column<PaymentSummary>> = [
    { key: 'no', header: 'Receipt', mobile: 'title', cell: (p) => <div><p className="font-medium">{p.receiptNumber}</p><p className="text-xs text-muted">{fmtDateTime(p.receivedAt, timezone)}</p></div> },
    { key: 'customer', header: 'Customer', cell: (p) => p.customerName },
    { key: 'method', header: 'Method', hideBelow: 'md', cell: (p) => PAYMENT_METHOD_LABELS[p.method] },
    { key: 'by', header: 'Received by', hideBelow: 'lg', cell: (p) => p.receivedByName },
    { key: 'amount', header: 'Amount', align: 'right', cell: (p) => <Money value={p.amount} /> },
    { key: 'adv', header: 'Kept as advance', align: 'right', hideBelow: 'lg', cell: (p) => (p.unallocatedAmount > 0 ? <Money value={p.unallocatedAmount} /> : '—') },
    { key: 'status', header: 'Status', cell: (p) => (p.status === 'void' ? <Badge tone="neutral">Cancelled</Badge> : p.refundedAmount > 0 ? <Badge tone="warning">Part refunded</Badge> : <Badge tone="success">Received</Badge>) },
  ];
  return (
    <div>
      <PageHeader title="Payments received" description="Every payment, with the receipt number and who took it." />
      <Card padded={false}>
        <div className="space-y-3 border-b border-line p-4">
          <RangeControls r={r} />
          <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
            <SearchInput value={text} onChange={(v) => { setText(v); r.set({ q: v.trim() || null }); }} placeholder="Receipt number or customer" />
            <Field label="Method" className="sr-only"><Select value={method} onChange={(e) => r.set({ method: e.target.value })}><option value="">All methods</option>{PAYMENT_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}</Select></Field>
          </div>
        </div>
        <DataTable columns={columns} rows={list.data?.rows} rowKey={(p) => p.id} loading={list.isLoading || list.isFetching} error={list.isError ? list.error : undefined} onRetry={() => void list.refetch()} onRowClick={(p) => navigate(`/billing/payments/${p.id}`)} pagination={list.data ? { page: r.page, pageSize: 25, total: list.data.meta.total, onPageChange: (p) => r.set({ page: String(p) }) } : undefined} empty={<EmptyState title="No payments in this period" />} />
      </Card>
    </div>
  );
}
