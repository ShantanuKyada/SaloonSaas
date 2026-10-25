import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS, type PaymentDto } from '@salon/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CheckCircle2, Printer, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { toastError } from '@/app/providers';
import { Money, useMoney } from '@/components/common/badges';
import { Button } from '@/components/ui/button';
import { Badge, Card, ErrorState, InlineNotice, PageHeader, Skeleton } from '@/components/ui/display';
import { Field, MoneyInput, Select, Textarea } from '@/components/ui/form';
import { Modal } from '@/components/ui/overlay';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { fmtDateTime } from '@/lib/format';
import { qk } from '@/lib/queries';

export function Component() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const can = useCan();
  const money = useMoney();
  const client = useQueryClient();
  const { timezone } = useBranch();
  const [dialog, setDialog] = useState<null | 'void' | 'refund'>(null);
  const q = useQuery({ queryKey: qk.payment(id ?? ''), queryFn: () => api.get<PaymentDto>(`/payments/${id}`), enabled: !!id });
  if (q.isLoading) return <div role="status" aria-label="Loading receipt" className="mx-auto max-w-xl space-y-3"><Skeleton className="h-16" /><Skeleton className="h-64" /></div>;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const p = q.data;
  const refresh = () => { void client.invalidateQueries({ queryKey: qk.payment(p.id) }); for (const k of ['payments', 'customer-360', 'outstanding', 'bills', 'invoice', 'dashboard']) void client.invalidateQueries({ queryKey: [k] }); };
  const refundable = p.amount - p.refundedAmount;

  return (
    <div className="mx-auto max-w-xl">
      <div className="no-print">
        <PageHeader back={<Link to="/billing/payments" className="mb-1 inline-block text-sm text-muted hover:text-fg">← Payments received</Link>} title={`Receipt ${p.receiptNumber}`} description={`${p.customerName} · ${fmtDateTime(p.receivedAt, timezone)}`} actions={<Button variant="outline" icon={<Printer className="size-4" />} onClick={() => window.print()}>Print receipt</Button>} />
        {params.get('created') === '1' && <div className="mb-4"><InlineNotice tone="success" title={<span className="inline-flex items-center gap-2"><CheckCircle2 className="size-5" aria-hidden />Payment recorded</span>}>{p.unallocatedAmount > 0 ? `${money(p.unallocatedAmount)} was kept as advance for the customer’s next bill.` : 'Applied to the customer’s pending bills.'}</InlineNotice></div>}
        {p.status === 'void' && <div className="mb-4"><InlineNotice tone="danger" title="This payment was cancelled">The bills it paid are pending again.</InlineNotice></div>}
      </div>
      <Card className="print-area">
        <div className="border-b border-line pb-3 text-center">
          <p className="text-lg font-semibold">{p.organization.name}</p>
          <p className="text-sm text-muted">{p.branch.name}{p.branch.phone ? ` · ${p.branch.phone}` : ''}</p>
          <p className="mt-2 text-xs uppercase tracking-wide text-muted">Payment receipt</p>
        </div>
        <dl className="mt-4 space-y-2 text-sm">
          <Row label="Receipt no." value={p.receiptNumber} />
          <Row label="Received from" value={p.customerName} />
          <Row label="Date" value={fmtDateTime(p.receivedAt, timezone)} />
          <Row label="Method" value={`${PAYMENT_METHOD_LABELS[p.method]}${p.reference ? ` (${p.reference})` : ''}`} />
          <Row label="Received by" value={p.receivedByName} />
        </dl>
        <p className="my-5 text-center text-3xl font-semibold tabular-nums"><Money value={p.amount} /></p>
        {p.allocations.length > 0 && (
          <div className="border-t border-line pt-3">
            <h3 className="mb-1.5 text-sm font-semibold">Applied to</h3>
            <ul className="space-y-1 text-sm">{p.allocations.filter((a) => !a.reversedAt).map((a) => <li key={a.invoiceId + a.amount} className="flex justify-between"><Link to={`/billing/bills/${a.invoiceId}`} className="text-primary hover:underline">{a.invoiceNumber}</Link><Money value={a.amount} /></li>)}</ul>
          </div>
        )}
        {p.unallocatedAmount > 0 && <p className="mt-3 flex justify-between text-sm"><span className="text-muted">Kept as advance</span><Money value={p.unallocatedAmount} /></p>}
        {p.refunds.length > 0 && <div className="mt-3 border-t border-line pt-3"><h3 className="mb-1.5 text-sm font-semibold">Refunds</h3><ul className="space-y-1 text-sm">{p.refunds.map((r) => <li key={r.id} className="flex justify-between"><span>{r.refundNumber} <span className="text-muted">· {r.reason}</span></span><Money value={r.amount} /></li>)}</ul></div>}
        <p className="mt-4 flex justify-between border-t border-line pt-3 text-sm"><span className="text-muted">Customer’s balance after this</span><span className="font-semibold tabular-nums">{p.customerBalanceAfter > 0 ? <><Money value={p.customerBalanceAfter} /> pending</> : p.customerBalanceAfter < 0 ? <><Money value={-p.customerBalanceAfter} /> advance</> : 'Nothing pending'}</span></p>
        <p className="mt-4 text-center text-xs text-muted">{p.organization.receiptFooter ?? 'Thank you!'}</p>
        {p.status === 'void' && <p className="mt-2 text-center"><Badge tone="danger">Cancelled</Badge></p>}
      </Card>
      {p.status === 'completed' && (
        <div className="no-print mt-4 flex flex-wrap gap-2">
          {can('payments.refund') && refundable > 0 && <Button variant="outline" icon={<Undo2 className="size-4" />} onClick={() => setDialog('refund')}>Refund</Button>}
          {can('payments.void') && p.refundedAmount === 0 && <Button variant="ghost" className="text-danger" icon={<Ban className="size-4" />} onClick={() => setDialog('void')}>Cancel this payment</Button>}
        </div>
      )}
      {dialog === 'void' && <VoidDialog p={p} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'refund' && <RefundDialog p={p} max={refundable} onClose={() => setDialog(null)} onDone={refresh} />}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-4"><dt className="text-muted">{label}</dt><dd className="text-right font-medium">{value}</dd></div>;
}

function VoidDialog({ p, onClose, onDone }: { p: PaymentDto; onClose: () => void; onDone: () => void }) {
  const money = useMoney();
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api.post(`/payments/${p.id}/void`, { reason }), onSuccess: () => { toast.success('Payment cancelled'); onDone(); onClose(); }, onError: toastError });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Cancel this payment?" size="sm" footer={<><Button variant="outline" onClick={onClose}>Keep payment</Button><Button variant="danger" disabled={reason.trim().length < 3} loading={m.isPending} onClick={() => m.mutate()}>Cancel payment</Button></>}>
      <div className="space-y-4 text-sm">
        <p>Receipt {p.receiptNumber} ({money(p.amount)} from {p.customerName}) will be cancelled and the bills it paid become pending again.</p>
        <Field label="Reason" required><Textarea rows={2} value={reason} autoFocus onChange={(e) => setReason(e.target.value)} placeholder="e.g. Entered by mistake" /></Field>
      </div>
    </Modal>
  );
}

function RefundDialog({ p, max, onClose, onDone }: { p: PaymentDto; max: number; onClose: () => void; onDone: () => void }) {
  const money = useMoney();
  const [amount, setAmount] = useState<number | null>(p.unallocatedAmount > 0 ? Math.min(p.unallocatedAmount, max) : max);
  const [method, setMethod] = useState(p.method);
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api.post('/payments/refund', { paymentId: p.id, amount, method, reason }), onSuccess: () => { toast.success('Refund recorded'); onDone(); onClose(); }, onError: toastError });
  const touchesBills = amount !== null && amount > p.unallocatedAmount;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Refund" size="sm" footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!amount || amount > max || reason.trim().length < 3} loading={m.isPending} onClick={() => m.mutate()}>Record refund</Button></>}>
      <div className="space-y-4">
        <Field label="Amount to refund" hint={`Up to ${money(max)}.`}><MoneyInput value={amount} onChange={setAmount} /></Field>
        {touchesBills && <InlineNotice tone="warning">Part of this was applied to bills. Those bills will show the refunded amount as pending again.</InlineNotice>}
        <Field label="Refunded by"><Select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>{PAYMENT_METHODS.map((m2) => <option key={m2} value={m2}>{PAYMENT_METHOD_LABELS[m2]}</option>)}</Select></Field>
        <Field label="Reason" required><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
