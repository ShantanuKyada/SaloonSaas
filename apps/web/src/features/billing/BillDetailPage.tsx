import { PAYMENT_METHOD_LABELS, formatPercentBp, type InvoiceDto } from '@salon/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CheckCircle2, MessageCircle, Printer, Scale, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { toastError } from '@/app/providers';
import { Money, PaymentBadge, useMoney } from '@/components/common/badges';
import { Button } from '@/components/ui/button';
import { Badge, Card, ErrorState, InlineNotice, PageHeader, Skeleton } from '@/components/ui/display';
import { Field, MoneyInput, Segmented, Textarea } from '@/components/ui/form';
import { Modal } from '@/components/ui/overlay';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { fmtDateTime, fmtDay } from '@/lib/format';
import { qk } from '@/lib/queries';

export function Component() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const can = useCan();
  const money = useMoney();
  const client = useQueryClient();
  const { timezone } = useBranch();
  const [dialog, setDialog] = useState<null | 'void' | 'adjust'>(null);
  const q = useQuery({ queryKey: qk.invoice(id ?? ''), queryFn: () => api.get<InvoiceDto>(`/billing/invoices/${id}`), enabled: !!id });
  if (q.isLoading) return <div role="status" aria-label="Loading bill" className="mx-auto max-w-3xl space-y-3"><Skeleton className="h-16" /><Skeleton className="h-80" /></div>;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const inv = q.data;
  const created = params.get('created') === '1';
  const done = () => { void client.invalidateQueries({ queryKey: qk.invoice(inv.id) }); for (const k of ['customer-360', 'appointments', 'dashboard', 'outstanding', 'bills']) void client.invalidateQueries({ queryKey: [k] }); };

  const shareText = encodeURIComponent(`Thank you for visiting ${inv.organization.name}! Bill ${inv.invoiceNumber} dated ${fmtDay(inv.invoiceDate, timezone, true)} — total ${money(inv.grandTotal)}${inv.balanceDue > 0 ? `, pending ${money(inv.balanceDue)}` : ', paid in full'}.`);
  const phone = inv.customer.mobile?.replace(/[^\d]/g, '');

  return (
    <div className="mx-auto max-w-3xl">
      <div className="no-print">
        <PageHeader
          back={<Link to="/billing/bills" className="mb-1 inline-block text-sm text-muted hover:text-fg">← All bills</Link>}
          title={inv.invoiceNumber}
          description={`${inv.customer.fullName} · ${fmtDateTime(inv.issuedAt, timezone)}`}
          actions={
            <>
              <Button variant="outline" icon={<Printer className="size-4" />} onClick={() => window.print()}>Print receipt</Button>
              {phone && <a className="inline-flex h-10 items-center gap-2 rounded-lg border border-line-strong bg-surface px-4 text-sm font-medium hover:bg-surface-2" href={`https://wa.me/${phone}?text=${shareText}`} target="_blank" rel="noreferrer"><MessageCircle className="size-4" aria-hidden />Share on WhatsApp</a>}
              {inv.status === 'issued' && inv.balanceDue > 0 && can('payments.collect') && <Button icon={<Wallet className="size-4" />} onClick={() => navigate(`/billing/collect?customerId=${inv.customer.id}&invoiceId=${inv.id}`)}>Collect {money(inv.balanceDue)}</Button>}
            </>
          }
        />
        {created && <div className="mb-4"><InlineNotice tone="success" title={<span className="inline-flex items-center gap-2"><CheckCircle2 className="size-5" aria-hidden />Bill created</span>} action={<div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => navigate('/billing/new')}>New bill</Button><Button size="sm" variant="outline" onClick={() => navigate('/desk')}>Back to front desk</Button></div>}>{inv.balanceDue > 0 ? `${money(inv.balanceDue)} is pending on ${inv.customer.fullName.split(' ')[0]}'s account.` : 'Paid in full. A receipt was queued for the customer if they agreed to messages.'}</InlineNotice></div>}
        {inv.status === 'void' && <div className="mb-4"><InlineNotice tone="danger" title="This bill was cancelled">{inv.voidReason} · {fmtDateTime(inv.voidedAt, timezone)}</InlineNotice></div>}
      </div>

      <Card className="print-area">
        <div className="flex items-start justify-between gap-4 border-b border-line pb-4">
          <div>
            <h2 className="text-lg font-semibold">{inv.organization.name}</h2>
            <p className="text-sm text-muted">{inv.branch.name}{inv.branch.address ? ` · ${inv.branch.address}` : ''}{inv.branch.phone ? ` · ${inv.branch.phone}` : ''}</p>
            {inv.organization.taxId && <p className="text-xs text-muted">{inv.organization.taxLabel}: {inv.organization.taxId}</p>}
          </div>
          <div className="text-right text-sm">
            <p className="font-semibold">{inv.invoiceNumber}</p>
            <p className="text-muted">{fmtDay(inv.invoiceDate, timezone, true)}</p>
            <div className="no-print mt-1"><PaymentBadge status={inv.paymentStatus} /></div>
          </div>
        </div>
        <p className="mt-3 text-sm"><span className="text-muted">Billed to </span><span className="font-medium">{inv.customer.fullName}</span> ({inv.customer.customerCode}){inv.customer.mobile ? ` · ${inv.customer.mobile}` : ''}</p>

        <div className="scroll-thin mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted"><th className="py-2 font-medium">Item</th><th className="py-2 text-right font-medium">Qty</th><th className="py-2 text-right font-medium">Rate</th><th className="py-2 text-right font-medium">Discount</th><th className="py-2 text-right font-medium">Tax</th><th className="py-2 text-right font-medium">Amount</th></tr></thead>
            <tbody>
              {inv.lines.map((l) => (
                <tr key={l.id} className="border-b border-line last:border-0">
                  <td className="py-2.5"><p className="font-medium">{l.description}</p>{l.staffName && <p className="text-xs text-muted">{l.staffName}</p>}</td>
                  <td className="py-2.5 text-right tabular-nums">{l.quantity}</td>
                  <td className="py-2.5 text-right tabular-nums"><Money value={l.unitPrice} /></td>
                  <td className="py-2.5 text-right tabular-nums">{l.discountAmount > 0 ? <Money value={-l.discountAmount} /> : '—'}</td>
                  <td className="py-2.5 text-right tabular-nums text-muted">{l.taxAmount > 0 ? <>{formatPercentBp(l.taxRateBp)}</> : '—'}</td>
                  <td className="py-2.5 text-right font-medium tabular-nums"><Money value={l.lineTotal} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <dl className="ml-auto mt-4 max-w-xs space-y-1.5 text-sm">
          <Line label="Subtotal" value={inv.subtotal} />
          {inv.offerDiscount > 0 && <Line label={`Offer${inv.offerName ? `: ${inv.offerName}` : ''}`} value={-inv.offerDiscount} />}
          {inv.manualDiscount > 0 && <Line label={`Discount${inv.manualDiscountReason ? ` (${inv.manualDiscountReason})` : ''}`} value={-inv.manualDiscount} />}
          {inv.taxTotal > 0 && <Line label={`${inv.organization.taxLabel}${inv.pricesIncludeTax ? ' (included)' : ''}`} value={inv.taxTotal} />}
          {inv.roundOff !== 0 && <Line label="Round off" value={inv.roundOff} />}
          <div className="flex justify-between border-t border-line pt-2 text-base font-semibold"><dt>Total</dt><dd className="tabular-nums"><Money value={inv.grandTotal} /></dd></div>
          {inv.amountPaid > 0 && <Line label="Paid" value={inv.amountPaid} />}
          {inv.amountAdjusted > 0 && <Line label="Adjusted / written off" value={inv.amountAdjusted} />}
          {inv.status === 'issued' && <div className={`flex justify-between font-semibold ${inv.balanceDue > 0 ? 'text-warning' : 'text-success'}`}><dt>{inv.balanceDue > 0 ? 'Pending' : 'Fully paid'}</dt><dd className="tabular-nums">{inv.balanceDue > 0 && <Money value={inv.balanceDue} />}</dd></div>}
        </dl>

        {inv.payments.length > 0 && (
          <div className="mt-5 border-t border-line pt-4">
            <h3 className="mb-2 text-sm font-semibold">Payments on this bill</h3>
            <ul className="space-y-1 text-sm">
              {inv.payments.map((p) => (
                <li key={p.paymentId} className="flex justify-between"><span><Link to={`/billing/payments/${p.paymentId}`} className="text-primary hover:underline">{p.receiptNumber}</Link> <span className="text-muted">· {PAYMENT_METHOD_LABELS[p.method]} · {fmtDateTime(p.receivedAt, timezone)}</span></span><Money value={p.amount} /></li>
              ))}
            </ul>
          </div>
        )}
        {inv.adjustments.length > 0 && (
          <div className="mt-4">
            <h3 className="mb-2 text-sm font-semibold">Adjustments</h3>
            <ul className="space-y-1 text-sm">{inv.adjustments.map((a) => <li key={a.id} className="flex justify-between"><span><Badge tone="neutral">{a.type === 'write_off' ? 'Written off' : a.type === 'discount' ? 'Discount' : 'Adjustment'}</Badge> <span className="text-muted">{a.reason} · {fmtDateTime(a.createdAt, timezone)}</span></span><Money value={a.amount} /></li>)}</ul>
          </div>
        )}
        {inv.notes && <p className="mt-4 text-sm text-muted">Note: {inv.notes}</p>}
        <p className="mt-5 text-center text-xs text-muted">{inv.organization.receiptFooter ?? 'Thank you for visiting!'}</p>
      </Card>

      {inv.status === 'issued' && (
        <div className="no-print mt-4 flex flex-wrap gap-2">
          {inv.balanceDue > 0 && can(['ledger.adjust', 'ledger.write_off']) && <Button variant="outline" icon={<Scale className="size-4" />} onClick={() => setDialog('adjust')}>Adjust or write off</Button>}
          {can('billing.void') && <Button variant="ghost" className="text-danger" icon={<Ban className="size-4" />} onClick={() => setDialog('void')}>Cancel this bill</Button>}
        </div>
      )}
      {dialog === 'void' && <VoidDialog inv={inv} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'adjust' && <AdjustDialog inv={inv} onClose={() => setDialog(null)} onDone={done} />}
    </div>
  );
}

function Line({ label, value }: { label: string; value: number }) {
  return <div className="flex justify-between"><dt className="text-muted">{label}</dt><dd className="tabular-nums"><Money value={value} /></dd></div>;
}

function VoidDialog({ inv, onClose, onDone }: { inv: InvoiceDto; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api.post(`/billing/invoices/${inv.id}/void`, { reason }), onSuccess: () => { toast.success('Bill cancelled'); onDone(); onClose(); }, onError: toastError });
  const money = useMoney();
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Cancel this bill?" size="sm" footer={<><Button variant="outline" onClick={onClose}>Keep the bill</Button><Button variant="danger" disabled={reason.trim().length < 3} loading={m.isPending} onClick={() => m.mutate()}>Cancel bill</Button></>}>
      <div className="space-y-4 text-sm">
        <p>{inv.invoiceNumber} for {inv.customer.fullName} ({money(inv.grandTotal)}) will be cancelled. {inv.amountPaid > 0 ? `The ${money(inv.amountPaid)} already paid stays on the customer’s account as advance, and can be refunded.` : ''} Package sessions and offers used on it are given back.</p>
        <Field label="Why is it being cancelled?" required><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
      </div>
    </Modal>
  );
}

function AdjustDialog({ inv, onClose, onDone }: { inv: InvoiceDto; onClose: () => void; onDone: () => void }) {
  const can = useCan();
  const [type, setType] = useState<'discount' | 'write_off' | 'credit'>('discount');
  const [amount, setAmount] = useState<number | null>(inv.balanceDue);
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api.post('/ledger/adjustments', { invoiceId: inv.id, type, amount, reason }), onSuccess: () => { toast.success('Recorded'); onDone(); onClose(); }, onError: toastError });
  const options = [{ value: 'discount' as const, label: 'Discount', show: can('ledger.adjust') }, { value: 'credit' as const, label: 'Correction', show: can('ledger.adjust') }, { value: 'write_off' as const, label: 'Write off', show: can('ledger.write_off') }].filter((o) => o.show);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Adjust this bill" description={`${inv.invoiceNumber} · ${inv.customer.fullName}`} size="sm" footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!amount || amount > inv.balanceDue || reason.trim().length < 3} loading={m.isPending} onClick={() => m.mutate()}>Record</Button></>}>
      <div className="space-y-4">
        <Segmented label="Type" value={type} onChange={setType} options={options} />
        <Field label="Amount" hint={`Up to ${new Intl.NumberFormat('en-IN').format(inv.balanceDue / 100)}, the amount still pending.`}><MoneyInput value={amount} onChange={setAmount} /></Field>
        <Field label="Reason" required><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Regular customer, service redone" /></Field>
        <p className="text-xs text-muted">This reduces what the customer owes and is recorded in the activity log. The original bill is never edited.</p>
      </div>
    </Modal>
  );
}
