import { LEDGER_ENTRY_LABELS, type LedgerStatement } from '@salon/shared';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Money, useMoney } from '@/components/common/badges';
import { CustomerPicker, toPicked, useCustomer360, type PickedCustomer } from '@/components/common/CustomerPicker';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, ErrorState, InlineNotice, PageHeader, Skeleton, StatCard } from '@/components/ui/display';
import { DateInput, Field } from '@/components/ui/form';
import { api } from '@/lib/api';
import { useBranch } from '@/lib/branch';
import { fmtDateTime } from '@/lib/format';

/** Every bill, payment and adjustment for one customer with a running balance: the single source of truth for what they owe. */
export function Component() {
  const [params, setParams] = useSearchParams();
  const money = useMoney();
  const { timezone, scopeBranchId } = useBranch();
  const customerId = params.get('customerId');
  const [picked, setPicked] = useState<PickedCustomer | null>(null);
  const loaded = useCustomer360(customerId);
  useEffect(() => { if (loaded.data) setPicked(toPicked(loaded.data)); }, [loaded.data]);
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    setParams(next, { replace: true });
  };
  const q = useQuery({ queryKey: ['ledger', customerId, from, to, scopeBranchId], queryFn: () => api.get<LedgerStatement>('/ledger', { customerId: customerId!, from: from || undefined, to: to || undefined, branchId: scopeBranchId }), enabled: !!customerId });

  return (
    <div>
      <PageHeader title="Customer ledger" description="A running account of bills and payments." actions={customerId && <Button variant="outline" icon={<Download className="size-4" />} onClick={() => void api.download('/ledger/export', { customerId, from: from || undefined, to: to || undefined, branchId: scopeBranchId })}>Export</Button>} />
      <Card className="mb-5">
        <CustomerPicker value={customerId} onChange={(c) => { set({ customerId: c?.id ?? null }); setPicked(c); }} autoFocus={!customerId} />
        {customerId && <div className="mt-4 flex flex-wrap gap-3"><Field label="From" className="w-44"><DateInput value={from} onChange={(e) => set({ from: e.target.value })} /></Field><Field label="To" className="w-44"><DateInput value={to} onChange={(e) => set({ to: e.target.value })} /></Field></div>}
      </Card>
      {!customerId && <Card><EmptyState title="Choose a customer" description="Search by name or mobile number to see their account." /></Card>}
      {q.isLoading && customerId && <div role="status" aria-label="Loading ledger" className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-64" /></div>}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && (
        <div className="space-y-4">
          {q.data.scopedToBranches && <InlineNotice tone="info">Showing only the branches you have access to.</InlineNotice>}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Opening balance" value={money(q.data.openingBalance)} />
            <StatCard label="Billed" value={money(q.data.totalDebit)} />
            <StatCard label="Paid and adjusted" value={money(q.data.totalCredit)} />
            <StatCard label={q.data.closingBalance < 0 ? 'Advance held' : 'Pending'} value={money(Math.abs(q.data.closingBalance))} tone={q.data.closingBalance > 0 ? 'warning' : 'success'} hint={picked?.creditLimit != null ? `Credit limit ${money(picked.creditLimit)}` : undefined} />
          </div>
          <Card padded={false}>
            {q.data.rows.length === 0 ? <EmptyState title="No entries" description="Bills and payments will appear here." /> : (
              <div className="scroll-thin overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted"><th className="px-4 py-2.5 font-medium">Date</th><th className="px-4 py-2.5 font-medium">Reference</th><th className="px-4 py-2.5 font-medium">What</th><th className="px-4 py-2.5 text-right font-medium">Billed</th><th className="px-4 py-2.5 text-right font-medium">Paid / adjusted</th><th className="px-4 py-2.5 text-right font-medium">Balance</th></tr></thead>
                  <tbody>
                    <tr className="border-b border-line bg-surface-2/60"><td className="px-4 py-2.5 text-muted" colSpan={5}>Opening balance</td><td className="px-4 py-2.5 text-right tabular-nums"><Money value={q.data.openingBalance} /></td></tr>
                    {q.data.rows.map((r) => (
                      <tr key={r.id} className="border-b border-line last:border-0">
                        <td className="whitespace-nowrap px-4 py-2.5 text-muted">{fmtDateTime(r.occurredAt, timezone)}</td>
                        <td className="px-4 py-2.5">{r.sourceType === 'invoice' ? <Link className="text-primary hover:underline" to={`/billing/bills/${r.sourceId}`}>{r.reference}</Link> : r.sourceType === 'payment' ? <Link className="text-primary hover:underline" to={`/billing/payments/${r.sourceId}`}>{r.reference}</Link> : r.reference}</td>
                        <td className="px-4 py-2.5"><Badge tone={r.debit > 0 ? 'warning' : 'success'}>{LEDGER_ENTRY_LABELS[r.entryType]}</Badge><span className="ml-2 text-muted">{r.description}</span></td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{r.debit > 0 ? <Money value={r.debit} /> : ''}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{r.credit > 0 ? <Money value={r.credit} /> : ''}</td>
                        <td className="px-4 py-2.5 text-right font-medium tabular-nums"><Money value={r.balance} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
