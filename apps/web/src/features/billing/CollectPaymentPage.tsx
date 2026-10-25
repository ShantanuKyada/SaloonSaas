import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS, type PaymentDto, type PaymentMethod } from '@salon/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Wallet } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Money, useMoney } from '@/components/common/badges';
import { CustomerPicker, toPicked, useCustomer360, type PickedCustomer } from '@/components/common/CustomerPicker';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardHeader, EmptyState, InlineNotice, PageHeader, Skeleton } from '@/components/ui/display';
import { Checkbox, Field, Input, MoneyInput, Segmented, Select } from '@/components/ui/form';
import { api, newIdempotencyKey } from '@/lib/api';
import { useBranch } from '@/lib/branch';
import { friendlyError } from '@/lib/errors';
import { fmtDay } from '@/lib/format';

interface OpenInvoice {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string | null;
  branchName: string;
  grandTotal: number;
  balanceDue: number;
  ageDays: number;
  overdue: boolean;
}

/** Collect money: pick the customer, see what is pending, enter what was received. Oldest bills are paid first unless you choose. */
export function Component() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const money = useMoney();
  const { branchId, branches, timezone } = useBranch();
  const [payBranch, setPayBranch] = useState(branchId);
  const [customerId, setCustomerId] = useState<string | null>(params.get('customerId'));
  const [picked, setPicked] = useState<PickedCustomer | null>(null);
  const loaded = useCustomer360(customerId);
  useEffect(() => { if (loaded.data) setPicked(toPicked(loaded.data)); }, [loaded.data]);

  const open = useQuery({
    queryKey: ['outstanding', 'invoices', customerId],
    queryFn: () => api.list<OpenInvoice>('/outstanding/invoices', { customerId: customerId!, pageSize: 100 }),
    enabled: !!customerId,
  });
  const invoices = useMemo(() => open.data?.rows ?? [], [open.data]);
  const totalPending = invoices.reduce((a, i) => a + i.balanceDue, 0);

  const [chosen, setChosen] = useState<Set<string> | null>(params.get('invoiceId') ? new Set([params.get('invoiceId')!]) : null); // null = oldest first
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [reference, setReference] = useState('');
  const [typed, setTyped] = useState(false);

  const chosenInvoices = chosen ? invoices.filter((i) => chosen.has(i.id)) : invoices;
  const chosenTotal = chosenInvoices.reduce((a, i) => a + i.balanceDue, 0);
  useEffect(() => { if (!typed) setAmount(chosenTotal || null); }, [chosenTotal, typed]);

  // Show exactly where the money goes before it is taken.
  const plan = useMemo(() => {
    let left = amount ?? 0;
    const rows: Array<{ id: string; invoiceNumber: string; applied: number; remaining: number }> = [];
    for (const inv of chosenInvoices) {
      const applied = Math.min(left, inv.balanceDue);
      rows.push({ id: inv.id, invoiceNumber: inv.invoiceNumber, applied, remaining: inv.balanceDue - applied });
      left -= applied;
    }
    return { rows, advance: left };
  }, [amount, chosenInvoices]);

  const keyRef = useRef<{ sig: string; key: string } | null>(null);
  const allocations = chosen ? plan.rows.filter((r) => r.applied > 0).map((r) => ({ invoiceId: r.id, amount: r.applied })) : undefined;
  const request = { branchId: payBranch, customerId, amount, method, reference: reference || undefined, allocations, sendReceipt: true };
  const sig = JSON.stringify(request);
  if (keyRef.current?.sig !== sig) keyRef.current = { sig, key: newIdempotencyKey() };
  const collect = useMutation({ mutationFn: () => api.post<PaymentDto>('/payments/collect', request, { idempotencyKey: keyRef.current!.key }), onSuccess: (p) => navigate(`/billing/payments/${p.id}?created=1`, { replace: true }) });
  const err = collect.error ? friendlyError(collect.error) : null;
  const ready = !!customerId && !!amount && amount > 0;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Collect payment" description="Take money for pending bills, or keep it as advance." back={<Link to="/desk" className="mb-1 inline-block text-sm text-muted hover:text-fg">← Front desk</Link>} />
      <div className="space-y-5">
        <Card>
          <CardHeader title="Who is paying?" />
          {branches.length > 1 && <Field label="Receiving at" className="mb-3 max-w-64"><Select value={payBranch} onChange={(e) => setPayBranch(e.target.value)}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>}
          <CustomerPicker value={customerId} autoFocus={!customerId} onChange={(c) => { setCustomerId(c?.id ?? null); setPicked(c); setChosen(null); setTyped(false); }} />
        </Card>

        {customerId && (
          <Card padded={false}>
            <div className="p-4 pb-2"><CardHeader title="Pending bills" description={invoices.length ? `${money(totalPending)} across ${invoices.length} ${invoices.length === 1 ? 'bill' : 'bills'}. Oldest first.` : undefined} actions={invoices.length > 1 && <Checkbox checked={chosen === null} onCheckedChange={(v) => { setChosen(v ? null : new Set()); setTyped(false); }} label="Pay oldest first" />} /></div>
            {open.isLoading && <div className="space-y-2 p-4"><Skeleton className="h-12" /><Skeleton className="h-12" /></div>}
            {open.data && invoices.length === 0 && <EmptyState title="Nothing pending" description={`${picked?.fullName ?? 'This customer'} has no pending bills. You can still take an advance payment below.`} />}
            <ul className="divide-y divide-line">
              {invoices.map((inv) => {
                const row = plan.rows.find((r) => r.id === inv.id);
                const selected = chosen === null || chosen.has(inv.id);
                return (
                  <li key={inv.id} className="flex items-center gap-3 px-4 py-3">
                    {chosen !== null && <Checkbox checked={selected} onCheckedChange={(v) => { const next = new Set(chosen); if (v) next.add(inv.id); else next.delete(inv.id); setChosen(next); setTyped(false); }} />}
                    <div className="min-w-0 flex-1">
                      <p className="font-medium"><Link to={`/billing/bills/${inv.id}`} className="hover:underline">{inv.invoiceNumber}</Link> <span className="font-normal text-muted">· {fmtDay(inv.invoiceDate, timezone)} · {inv.branchName}</span></p>
                      <p className="text-xs text-muted">Bill total {money(inv.grandTotal)} · {inv.ageDays} days old{inv.overdue && <> · <span className="font-medium text-danger">overdue</span></>}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold tabular-nums text-warning"><Money value={inv.balanceDue} /></p>
                      {selected && row && row.applied > 0 && <p className="text-xs text-success">paying {money(row.applied)}{row.remaining > 0 ? `, ${money(row.remaining)} left` : ' — settled'}</p>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}

        {customerId && (
          <Card className="space-y-4">
            <CardHeader title="Payment" />
            <Field label="Amount received" required hint={chosenTotal > 0 ? `Pending on the selected bills: ${money(chosenTotal)}` : 'No pending bills: this will be kept as advance.'}>
              <MoneyInput value={amount} onChange={(v) => { setTyped(true); setAmount(v); }} autoFocus />
            </Field>
            <div><p className="mb-1.5 text-sm font-medium">How was it paid?</p><Segmented label="Payment method" value={method} onChange={setMethod} options={PAYMENT_METHODS.filter((m) => m !== 'other').map((m) => ({ value: m, label: PAYMENT_METHOD_LABELS[m] }))} /></div>
            {method !== 'cash' && <Field label="Reference" optional><Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UPI transaction id, last 4 digits of the card…" /></Field>}
            {plan.advance > 0 && amount && <InlineNotice tone="info" title={<span>{money(plan.advance)} will be kept as advance</span>}>It can be used on the customer’s next bill, or refunded.</InlineNotice>}
            {err && <InlineNotice tone="danger" title={err.title}>{err.message}{err.hints.length > 0 && <p className="mt-1">{err.hints.join(' · ')}</p>}</InlineNotice>}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted">{ready ? <>Receipt will be created for <span className="font-semibold text-fg">{money(amount ?? 0)}</span></> : 'Enter the amount received.'}</p>
              <Button size="lg" icon={<Wallet className="size-5" />} disabled={!ready} loading={collect.isPending} onClick={() => collect.mutate()}>Collect {amount ? money(amount) : ''}</Button>
            </div>
          </Card>
        )}
        {customerId && picked && picked.outstanding > 0 && invoices.length === 0 && open.data && <Badge tone="warning">The customer shows {money(picked.outstanding)} pending at a branch you cannot collect for.</Badge>}
      </div>
    </div>
  );
}
