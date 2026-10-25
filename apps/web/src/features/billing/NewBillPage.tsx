import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS, type InvoiceDto, type InvoiceLineInput, type InvoicePreview, type PaymentMethod } from '@salon/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Gift, Package, Plus, Trash2, Wallet } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Money, useMoney } from '@/components/common/badges';
import { CustomerPicker, toPicked, useCustomer360, type PickedCustomer } from '@/components/common/CustomerPicker';
import { ServicePicker } from '@/components/common/ServicePicker';
import { Button, IconButton } from '@/components/ui/button';
import { Badge, Card, CardHeader, EmptyState, InlineNotice, PageHeader, Skeleton } from '@/components/ui/display';
import { Checkbox, Field, Input, MoneyInput, Segmented, Select, Switch, Textarea } from '@/components/ui/form';
import { Modal } from '@/components/ui/overlay';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { friendlyError } from '@/lib/errors';
import { useDebounced } from '@/lib/hooks';
import { useServices, useStaffList } from '@/lib/queries';

type Line = InvoiceLineInput & { key: string };
interface PaymentPart {
  id: string;
  method: PaymentMethod;
  amount: number | null;
  reference: string;
}
const uid = () => crypto.randomUUID();

export function Component() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const can = useCan();
  const money = useMoney();
  const { branchId, branches } = useBranch();
  const [billBranch, setBillBranch] = useState(branchId);
  const [customerId, setCustomerId] = useState<string | null>(params.get('customerId'));
  const [picked, setPicked] = useState<PickedCustomer | null>(null);
  const [appointmentId] = useState<string | null>(params.get('appointmentId'));
  const [lines, setLines] = useState<Line[]>([]);
  const [offerId, setOfferId] = useState<string | null>(null);
  const [offerCode, setOfferCode] = useState('');
  const [discount, setDiscount] = useState<{ type: 'percentage' | 'flat'; value: number | null; reason: string } | null>(null);
  const [notes, setNotes] = useState('');
  const [parts, setParts] = useState<PaymentPart[]>([{ id: uid(), method: 'cash', amount: null, reference: '' }]);
  const [payLater, setPayLater] = useState(false);
  const [useAdvance, setUseAdvance] = useState(false);
  const [override, setOverride] = useState(false);
  const [adding, setAdding] = useState<null | 'service' | 'package' | 'custom'>(null);
  const [autoOfferApplied, setAutoOfferApplied] = useState(false);
  const [manualPay, setManualPay] = useState(false);

  const loaded = useCustomer360(customerId);
  useEffect(() => {
    if (loaded.data) setPicked(toPicked(loaded.data));
  }, [loaded.data]);

  const staff = useStaffList(billBranch, { bookableOnly: false });
  const services = useServices(billBranch, { popular: true });
  const serviceName = useMemo(() => new Map((services.data ?? []).map((s) => [s.id, s.name])), [services.data]);

  // Pre-fill from a finished appointment: one tap from "Complete" to a ready bill.
  const draft = useQuery({
    queryKey: ['bill-draft', appointmentId],
    queryFn: () => api.get<{ branchId: string; customerId: string; appointmentId: string; bookingNumber: string; lines: Line[] }>(`/billing/draft-from-appointment/${appointmentId}`),
    enabled: !!appointmentId && lines.length === 0,
    retry: false,
  });
  useEffect(() => {
    if (draft.data && lines.length === 0) {
      setBillBranch(draft.data.branchId);
      setCustomerId(draft.data.customerId);
      setLines(draft.data.lines);
    }
  }, [draft.data, lines.length]);

  const body = {
    branchId: billBranch,
    customerId,
    appointmentId,
    lines: lines.map((l) => (l.type === 'custom' ? { ...l, unitPrice: l.unitPrice } : l)),
    offerId,
    offerCode: offerId ? undefined : offerCode.trim() || undefined,
    manualDiscount: discount && discount.value ? { type: discount.type, value: discount.value, reason: discount.reason || 'Discount' } : undefined,
    notes: notes || undefined,
  };
  const debounced = useDebounced(body, 250);
  const preview = useQuery({
    queryKey: ['bill-preview', debounced],
    queryFn: () => api.post<InvoicePreview>('/billing/preview', debounced),
    enabled: !!debounced.customerId && debounced.lines.length > 0,
    placeholderData: (p) => p,
    retry: false,
  });
  const p = preview.data;
  const byKey = new Map((p?.lines ?? []).map((l) => [l.key, l]));

  // Offers flagged "apply automatically" (e.g. first-visit) are pre-selected once, visibly, and can be removed.
  useEffect(() => {
    if (p && !autoOfferApplied && !offerId) {
      const auto = p.applicableOffers.find((o) => o.autoApply);
      if (auto) setOfferId(auto.id);
      setAutoOfferApplied(true);
    }
  }, [p, autoOfferApplied, offerId]);

  const grand = p?.grandTotal ?? 0;
  const advanceAvailable = p?.customerAccount.advance ?? 0;
  const advanceUsed = useAdvance ? Math.min(advanceAvailable, grand) : 0;
  const dueNow = Math.max(grand - advanceUsed, 0);
  const paidParts = payLater ? [] : parts.map((x, i) => ({ ...x, amount: x.amount ?? (!manualPay && i === 0 ? dueNow : 0) })).filter((x) => (x.amount ?? 0) > 0);
  const paidTotal = paidParts.reduce((a, x) => a + (x.amount ?? 0), 0);
  const stillDue = Math.max(dueNow - paidTotal, 0);
  const change = Math.max(paidTotal - dueNow, 0);
  const creditLimit = p?.customerAccount.creditLimit ?? null;
  const projected = (p?.customerAccount.outstanding ?? 0) + grand - paidTotal;
  const overLimit = stillDue > 0 && creditLimit !== null && projected > creditLimit;

  // One idempotency key per distinct request: a double-click can never create two bills.
  const keyRef = useRef<{ sig: string; key: string } | null>(null);
  const request = {
    ...body,
    payments: paidParts.map((x) => ({ method: x.method, amount: x.amount, reference: x.reference || undefined })),
    useAdvance,
    allowCreditLimitOverride: override,
    sendReceipt: true,
  };
  const sig = JSON.stringify(request);
  if (keyRef.current?.sig !== sig) keyRef.current = { sig, key: newIdempotencyKey() };

  const create = useMutation({ mutationFn: () => api.post<InvoiceDto>('/billing/invoices', request, { idempotencyKey: keyRef.current!.key }), onSuccess: (inv) => navigate(`/billing/bills/${inv.id}?created=1`, { replace: true }) });
  const apiErr = create.error instanceof ApiError ? create.error : null;
  const err = create.error ? friendlyError(create.error) : null;
  const canOverride = apiErr?.errorCode === 'CREDIT_LIMIT_EXCEEDED' && apiErr.details.canOverride === true;

  const updateLine = (key: string, patch: Partial<Line>) => setLines((cur) => cur.map((l) => (l.key === key ? ({ ...l, ...patch } as Line) : l)));
  const packageFor = (serviceId: string) => {
    for (const pkg of picked?.packages ?? []) {
      if (pkg.status !== 'active' || new Date(pkg.expiresAt).getTime() < Date.now()) continue;
      const item = pkg.items.find((i) => i.serviceId === serviceId && i.remaining > 0);
      if (item) return { itemId: item.id, name: pkg.packageName, remaining: item.remaining };
    }
    return null;
  };

  const ready = !!customerId && lines.length > 0 && !!p && !preview.isError && (!overLimit || override);
  const staffOptions = staff.data ?? [];

  return (
    <div>
      <PageHeader title="New bill" description="Choose the customer, check the services, take payment." back={<Link to="/desk" className="mb-1 inline-block text-sm text-muted hover:text-fg">← Front desk</Link>} />
      <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
        <div className="space-y-5">
          <Card>
            <CardHeader title="Customer" />
            {branches.length > 1 && !appointmentId && (
              <Field label="Branch" className="mb-3 max-w-64"><Select value={billBranch} onChange={(e) => setBillBranch(e.target.value)}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
            )}
            <CustomerPicker value={customerId} onChange={(c) => { setCustomerId(c?.id ?? null); setPicked(c); setOfferId(null); setAutoOfferApplied(false); }} autoFocus={!customerId} />
          </Card>

          <Card padded={false}>
            <div className="flex flex-wrap items-center justify-between gap-2 p-4 pb-2">
              <h2 className="text-base font-semibold">Services and items</h2>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="soft" icon={<Plus className="size-4" />} onClick={() => setAdding('service')}>Add service</Button>
                {can('packages.manage') || can('billing.create') ? <Button size="sm" variant="outline" icon={<Package className="size-4" />} onClick={() => setAdding('package')}>Sell package</Button> : null}
                <Button size="sm" variant="outline" onClick={() => setAdding('custom')}>Other item</Button>
              </div>
            </div>
            {draft.isError && <div className="px-4 pb-3"><InlineNotice tone="warning" title="This appointment can’t be billed yet">{friendlyError(draft.error).message}</InlineNotice></div>}
            {draft.isLoading && <div className="space-y-2 p-4"><Skeleton className="h-14" /></div>}
            {lines.length === 0 && !draft.isLoading ? (
              <EmptyState title="Nothing on this bill yet" description="Add the services the customer received." action={<Button onClick={() => setAdding('service')}>Add service</Button>} />
            ) : (
              <ul className="divide-y divide-line">
                {lines.map((l) => {
                  const pl = byKey.get(l.key);
                  const svcId = l.type === 'service' ? l.serviceId : null;
                  const pkg = svcId ? packageFor(svcId) : null;
                  return (
                    <li key={l.key} className="space-y-2 px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-medium">{pl?.description ?? (l.type === 'service' ? serviceName.get(l.serviceId) : l.type === 'custom' ? l.description : '…')}</p>
                          {pl && pl.quantity > 1 && <p className="text-xs text-muted">{pl.quantity} × {money(pl.unitPrice)}</p>}
                        </div>
                        <div className="flex items-center gap-2">
                          {pl ? <span className="text-right text-sm font-semibold tabular-nums">{pl.itemType === 'package_redemption' ? <Badge tone="success">Package</Badge> : money(pl.gross)}</span> : <Skeleton className="h-5 w-16" />}
                          <IconButton label="Remove" size="sm" onClick={() => setLines((cur) => cur.filter((x) => x.key !== l.key))}><Trash2 className="size-4" /></IconButton>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        {l.type !== 'package_sale' && (
                          <Select aria-label="Team member" className="h-9 w-48 text-xs" value={('staffId' in l && l.staffId) || ''} onChange={(e) => updateLine(l.key, { staffId: e.target.value || null } as Partial<Line>)}>
                            <option value="">Team member…</option>
                            {staffOptions.map((s) => <option key={s.id} value={s.id}>{s.displayName}</option>)}
                          </Select>
                        )}
                        {l.type === 'service' && pkg && (
                          <Button size="sm" variant="soft" icon={<Package className="size-4" />} onClick={() => updateLine(l.key, { type: 'package_redemption', customerPackageItemId: pkg.itemId, serviceId: undefined } as unknown as Partial<Line>)}>Use {pkg.name} ({pkg.remaining} left)</Button>
                        )}
                        {l.type === 'package_redemption' && <span className="text-xs text-success">Uses a package session: nothing to pay</span>}
                        {(l.type === 'service' || l.type === 'custom') && (
                          <label className="flex items-center gap-1.5 text-xs text-muted">Qty
                            <Input type="number" min={1} max={99} className="h-9 w-16 text-center" value={l.quantity} onChange={(e) => updateLine(l.key, { quantity: Math.max(1, Math.min(99, Number(e.target.value) || 1)) })} />
                          </label>
                        )}
                        {pl && pl.discount > 0 && <span className="text-xs text-success">Discount −{money(pl.discount)}</span>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {lines.length > 0 && (
            <Card>
              <CardHeader title="Offers and discounts" />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Offer" hint={p?.offerMessage ?? undefined}>
                  <Select value={offerId ?? ''} onChange={(e) => { setOfferId(e.target.value || null); if (e.target.value) setOfferCode(''); }}>
                    <option value="">No offer</option>
                    {(p?.applicableOffers ?? []).map((o) => <option key={o.id} value={o.id}>{o.name} — saves {money(o.estimatedDiscount)}</option>)}
                  </Select>
                </Field>
                <Field label="Or enter an offer code" optional>
                  <Input value={offerCode} disabled={!!offerId} onChange={(e) => setOfferCode(e.target.value.toUpperCase())} placeholder="e.g. FESTIVE10" />
                </Field>
              </div>
              {p?.offer && <p className="mt-2 flex items-center gap-1.5 text-sm text-success"><Gift className="size-4" aria-hidden />“{p.offer.name}” applied: {money(p.offerDiscount)} off</p>}
              {can('billing.discount') && (
                <div className="mt-4 border-t border-line pt-4">
                  <Switch checked={!!discount} onCheckedChange={(v) => setDiscount(v ? { type: 'percentage', value: null, reason: '' } : null)} label="Give a manual discount" description="For managers. A reason is recorded on the bill." />
                  {discount && (
                    <div className="mt-3 grid gap-3 sm:grid-cols-3">
                      <Segmented label="Discount type" value={discount.type} onChange={(t) => setDiscount({ ...discount, type: t, value: null })} options={[{ value: 'percentage', label: '%' }, { value: 'flat', label: 'Amount' }]} />
                      {discount.type === 'flat' ? <MoneyInput value={discount.value} onChange={(v) => setDiscount({ ...discount, value: v })} /> : <Input type="number" min={1} max={100} placeholder="10" suffix="%" value={discount.value ? discount.value / 100 : ''} onChange={(e) => setDiscount({ ...discount, value: e.target.value ? Math.round(Number(e.target.value) * 100) : null })} />}
                      <Input placeholder="Reason (required)" value={discount.reason} onChange={(e) => setDiscount({ ...discount, reason: e.target.value })} />
                    </div>
                  )}
                </div>
              )}
              <Field label="Note on the bill" optional className="mt-4"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
            </Card>
          )}
        </div>

        <aside className="lg:sticky lg:top-20 lg:self-start">
          <Card className="space-y-4">
            <h2 className="text-base font-semibold">Summary</h2>
            {!p && lines.length > 0 && <Skeleton className="h-24" />}
            {!p && lines.length === 0 && <p className="text-sm text-muted">The total appears here once you add a service.</p>}
            {preview.isError && <InlineNotice tone="danger" title="Could not price this bill">{friendlyError(preview.error).message}</InlineNotice>}
            {p && (
              <>
                <dl className="space-y-1.5 text-sm">
                  <SumRow label="Services and items" value={p.subtotal} />
                  {p.offerDiscount > 0 && <SumRow label={`Offer: ${p.offer?.name ?? ''}`} value={-p.offerDiscount} tone="success" />}
                  {p.manualDiscount > 0 && <SumRow label="Manual discount" value={-p.manualDiscount} tone="success" />}
                  {p.taxTotal > 0 && <SumRow label="Tax" value={p.taxTotal} />}
                  {p.roundOff !== 0 && <SumRow label="Round off" value={p.roundOff} />}
                  <div className="flex items-baseline justify-between border-t border-line pt-2 text-base font-semibold"><dt>Total</dt><dd className="text-xl tabular-nums"><Money value={p.grandTotal} /></dd></div>
                </dl>
                {p.warnings.map((w) => <InlineNotice key={w} tone="warning">{w}</InlineNotice>)}

                {grand > 0 && (
                  <div className="space-y-3 border-t border-line pt-4">
                    <h3 className="text-sm font-semibold">Payment</h3>
                    {advanceAvailable > 0 && <Switch checked={useAdvance} onCheckedChange={setUseAdvance} label={`Use advance (${money(advanceAvailable)})`} description="Already paid by the customer earlier." />}
                    <Switch checked={payLater} onCheckedChange={setPayLater} label="Pay later (credit)" description="The amount stays pending on the customer’s account." />
                    {!payLater && dueNow > 0 && (
                      <div className="space-y-3">
                        {parts.map((part, i) => (
                          <div key={part.id} className="space-y-2 rounded-xl bg-surface-2 p-3">
                            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Payment method">
                              {PAYMENT_METHODS.filter((m) => m !== 'other').map((m) => (
                                <button key={m} type="button" role="radio" aria-checked={part.method === m} onClick={() => setParts((cur) => cur.map((x) => (x.id === part.id ? { ...x, method: m } : x)))} className={`rounded-lg border px-3 py-1.5 text-sm font-medium max-md:min-h-10 ${part.method === m ? 'border-primary bg-primary text-primary-fg' : 'border-line bg-surface'}`}>{PAYMENT_METHOD_LABELS[m]}</button>
                              ))}
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="flex-1"><MoneyInput aria-describedby="" value={part.amount ?? (i === 0 && !manualPay ? dueNow : null)} onChange={(v) => { setManualPay(true); setParts((cur) => cur.map((x) => (x.id === part.id ? { ...x, amount: v } : x))); }} /></div>
                              {parts.length > 1 && <IconButton label="Remove this payment" size="sm" onClick={() => setParts((cur) => cur.filter((x) => x.id !== part.id))}><Trash2 className="size-4" /></IconButton>}
                            </div>
                            {part.method !== 'cash' && <Input placeholder="Reference (optional): UPI id, last 4 digits…" value={part.reference} onChange={(e) => setParts((cur) => cur.map((x) => (x.id === part.id ? { ...x, reference: e.target.value } : x)))} />}
                          </div>
                        ))}
                        <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => { setManualPay(true); setParts((cur) => [...cur, { id: uid(), method: 'upi', amount: null, reference: '' }]); }}>Split payment</Button>
                      </div>
                    )}
                    <dl className="space-y-1 text-sm">
                      {advanceUsed > 0 && <SumRow label="From advance" value={advanceUsed} />}
                      {!payLater && paidTotal > 0 && <SumRow label="Received now" value={paidTotal} />}
                      {stillDue > 0 && <div className="flex justify-between font-semibold text-warning"><dt>Pending after this bill</dt><dd className="tabular-nums"><Money value={stillDue} /></dd></div>}
                      {change > 0 && <div className="flex justify-between text-muted"><dt>Extra received (kept as advance)</dt><dd className="tabular-nums"><Money value={change} /></dd></div>}
                    </dl>
                    {overLimit && (
                      <InlineNotice tone="warning" title="Over the credit limit">
                        This would take pending payments to {money(projected)}, above the limit of {money(creditLimit ?? 0)}. Collect some payment now{can('billing.override_credit_limit') ? ', or approve below' : ', or ask a manager to approve'}.
                        {can('billing.override_credit_limit') && <div className="mt-2"><Checkbox checked={override} onCheckedChange={setOverride} label="Approve credit above the limit" /></div>}
                      </InlineNotice>
                    )}
                  </div>
                )}
              </>
            )}
            {err && (
              <InlineNotice tone="danger" title={err.title} action={canOverride ? <Button size="sm" variant="danger" onClick={() => { setOverride(true); setTimeout(() => create.mutate(), 0); }}>Continue anyway</Button> : undefined}>
                {err.message}
                {err.hints.length > 0 && !canOverride && <p className="mt-1">{err.hints.join(' · ')}</p>}
              </InlineNotice>
            )}
            <Button size="lg" className="w-full" disabled={!ready || create.isPending} loading={create.isPending} icon={<Wallet className="size-5" />} onClick={() => create.mutate()}>
              {payLater || stillDue > 0 ? (paidTotal > 0 ? 'Create bill (part paid)' : 'Create bill on credit') : 'Create bill and take payment'}
            </Button>
            {!ready && lines.length > 0 && customerId && p && !preview.isError && overLimit && !override && <p className="text-center text-xs text-muted">Collect more payment or approve the credit limit to continue.</p>}
          </Card>
        </aside>
      </div>

      {adding === 'service' && (
        <Modal open onOpenChange={(o) => !o && setAdding(null)} title="Add services" size="lg" footer={<Button onClick={() => setAdding(null)}>Done</Button>}>
          <ServicePicker services={services.data ?? []} selected={lines.flatMap((l) => (l.type === 'service' ? [l.serviceId] : []))} usualIds={[picked?.favoriteServiceId, picked?.suggestion?.serviceId].filter((v): v is string => !!v)} onToggle={(id) => setLines((cur) => (cur.some((l) => l.type === 'service' && l.serviceId === id) ? cur.filter((l) => !(l.type === 'service' && l.serviceId === id)) : [...cur, { type: 'service', key: uid(), serviceId: id, quantity: 1 }]))} />
        </Modal>
      )}
      {adding === 'package' && <PackageModal onClose={() => setAdding(null)} onPick={(packageId) => { setLines((cur) => [...cur, { type: 'package_sale', key: uid(), packageId, quantity: 1 }]); setAdding(null); }} />}
      {adding === 'custom' && <CustomItemModal onClose={() => setAdding(null)} onAdd={(description, unitPrice) => { setLines((cur) => [...cur, { type: 'custom', key: uid(), description, unitPrice, quantity: 1 }]); setAdding(null); }} />}
    </div>
  );
}

function SumRow({ label, value, tone }: { label: string; value: number; tone?: 'success' }) {
  return <div className={`flex justify-between ${tone === 'success' ? 'text-success' : ''}`}><dt className={tone ? '' : 'text-muted'}>{label}</dt><dd className="tabular-nums"><Money value={value} /></dd></div>;
}

function PackageModal({ onClose, onPick }: { onClose: () => void; onPick: (packageId: string) => void }) {
  const money = useMoney();
  const q = useQuery({ queryKey: ['packages'], queryFn: () => api.get<Array<{ id: string; name: string; price: number; originalValue: number; savings: number; validityDays: number; items: Array<{ serviceName: string; quantity: number }>; status: string }>>('/packages') });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Sell a package" size="lg">
      {q.isLoading && <Skeleton className="h-24" />}
      {q.data?.filter((p) => p.status === 'active').length === 0 && <EmptyState title="No packages yet" description="Create packages under Services → Packages & combos." />}
      <ul className="space-y-3">
        {q.data?.filter((p) => p.status === 'active').map((p) => (
          <li key={p.id} className="rounded-xl border border-line p-4">
            <div className="flex items-start justify-between gap-3">
              <div><p className="font-semibold">{p.name}</p><p className="text-sm text-muted">{p.items.map((i) => `${i.quantity}× ${i.serviceName}`).join(' + ')}</p><p className="text-xs text-muted">Valid for {p.validityDays} days</p></div>
              <div className="text-right"><p className="font-semibold">{money(p.price)}</p>{p.savings > 0 && <p className="text-xs text-success">Worth {money(p.originalValue)} · saves {money(p.savings)}</p>}</div>
            </div>
            <Button size="sm" className="mt-3" onClick={() => onPick(p.id)}>Add to bill</Button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function CustomItemModal({ onClose, onAdd }: { onClose: () => void; onAdd: (description: string, unitPrice: number) => void }) {
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState<number | null>(null);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Add another item" size="sm" footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={description.trim().length < 2 || price === null} onClick={() => onAdd(description.trim(), price ?? 0)}>Add to bill</Button></>}>
      <div className="space-y-4">
        <Field label="What is it?" required><Input value={description} autoFocus onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Hair serum, gift voucher" /></Field>
        <Field label="Price" required><MoneyInput value={price} onChange={setPrice} /></Field>
      </div>
    </Modal>
  );
}
