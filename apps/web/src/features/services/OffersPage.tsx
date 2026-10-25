import { zodResolver } from '@hookform/resolvers/zod';
import { OFFER_ELIGIBILITY, OFFER_ELIGIBILITY_LABELS, OFFER_SCOPES, WEEKDAYS, WEEKDAY_SHORT, offerSchema, type OfferEligibility, type OfferScope } from '@salon/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, MoreHorizontal, Pencil, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { toastError } from '@/app/providers';
import { useMoney } from '@/components/common/badges';
import { CustomerPicker } from '@/components/common/CustomerPicker';
import { MultiSelectList } from '@/components/common/MultiSelectList';
import { Button, IconButton } from '@/components/ui/button';
import { Badge, Card, EmptyState, ErrorState, PageHeader, Skeleton, type Tone } from '@/components/ui/display';
import { DateInput, Field, FormError, Input, MoneyInput, Segmented, Select, Switch, Textarea } from '@/components/ui/form';
import { Drawer, Menu, useConfirm } from '@/components/ui/overlay';
import { api, ApiError } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { friendlyError } from '@/lib/errors';
import { fmtDay, todayIn } from '@/lib/format';
import { qk, useCategories, useServices } from '@/lib/queries';

type FormIn = z.input<typeof offerSchema>;
type FormOut = z.output<typeof offerSchema>;

export interface OfferRow {
  id: string;
  name: string;
  description: string | null;
  code: string | null;
  discountType: 'percentage' | 'flat';
  discountValue: number;
  maxDiscountAmount: number | null;
  minBillAmount: number | null;
  appliesTo: OfferScope;
  eligibility: OfferEligibility;
  loyaltyMinVisits: number | null;
  loyaltyMinSpend: number | null;
  birthdayWindowDays: number;
  validFrom: string;
  validTo: string;
  validWeekdays: number[] | null;
  allBranches: boolean;
  autoApply: boolean;
  usageLimitTotal: number | null;
  usageLimitPerCustomer: number | null;
  usageCount: number;
  status: string;
  state: 'running' | 'scheduled' | 'expired' | 'used_up' | 'inactive';
  serviceIds: string[];
  categoryIds: string[];
  branchIds: string[];
  customers: Array<{ id: string; fullName: string }>;
}

const STATE: Record<OfferRow['state'], { label: string; tone: Tone }> = {
  running: { label: 'Running', tone: 'success' },
  scheduled: { label: 'Starts soon', tone: 'info' },
  expired: { label: 'Ended', tone: 'neutral' },
  used_up: { label: 'Fully used', tone: 'warning' },
  inactive: { label: 'Paused', tone: 'neutral' },
};
const SCOPE_LABEL: Record<OfferScope, string> = { all_services: 'Every service', services: 'Chosen services', categories: 'Whole categories', combo: 'Combo (all chosen services together)' };

export function Component() {
  const manage = useCan()('offers.manage');
  const money = useMoney();
  const confirm = useConfirm();
  const client = useQueryClient();
  const { timezone } = useBranch();
  const [editing, setEditing] = useState<OfferRow | 'new' | null>(null);
  const q = useQuery({ queryKey: qk.offers, queryFn: () => api.get<OfferRow[]>('/offers') });
  const archive = useMutation({ mutationFn: (id: string) => api.delete(`/offers/${id}`), onSuccess: () => { void client.invalidateQueries({ queryKey: qk.offers }); toast.success('Offer archived'); }, onError: toastError });
  const describe = (o: OfferRow) => (o.discountType === 'percentage' ? `${o.discountValue / 100}% off` : `${money(o.discountValue)} off`);

  return (
    <div>
      <PageHeader title="Offers" description="Discounts that apply automatically or with a code at the time of billing." actions={manage && <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Create offer</Button>} />
      {q.isLoading && <div role="status" aria-label="Loading offers" className="grid gap-3 md:grid-cols-2"><Skeleton className="h-36" /><Skeleton className="h-36" /></div>}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && q.data.length === 0 && <Card><EmptyState title="No offers yet" description="Create a festival discount, a first-visit welcome or a loyalty reward." action={manage && <Button onClick={() => setEditing('new')}>Create offer</Button>} /></Card>}
      <ul className="grid gap-3 md:grid-cols-2">
        {q.data?.map((o) => (
          <li key={o.id}>
            <Card className="h-full">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{o.name}</h2><Badge tone={STATE[o.state].tone}>{STATE[o.state].label}</Badge>{o.autoApply && <Badge tone="primary">Applied automatically</Badge>}</div>
                  <p className="mt-1 text-lg font-semibold text-primary">{describe(o)}{o.maxDiscountAmount ? <span className="text-sm font-normal text-muted"> (up to {money(o.maxDiscountAmount)})</span> : null}</p>
                  <p className="text-sm text-muted">{SCOPE_LABEL[o.appliesTo]} · {OFFER_ELIGIBILITY_LABELS[o.eligibility]}</p>
                  <p className="text-sm text-muted">{fmtDay(o.validFrom, timezone, true)} to {fmtDay(o.validTo, timezone, true)}{o.validWeekdays?.length ? ` · ${o.validWeekdays.map((d) => WEEKDAY_SHORT[d]).join(', ')}` : ''}</p>
                  {o.code && <p className="mt-2 inline-block rounded-md bg-surface-2 px-2 py-1 font-mono text-xs">Code: {o.code}</p>}
                  <p className="mt-2 text-xs text-muted">Used {o.usageCount}{o.usageLimitTotal ? ` of ${o.usageLimitTotal}` : ''} times</p>
                </div>
                {manage && (
                  <Menu label={`Actions for ${o.name}`} trigger={<IconButton label={`Actions for ${o.name}`} size="sm"><MoreHorizontal className="size-5" /></IconButton>} items={[
                    { label: 'Edit', icon: <Pencil className="size-4" />, onSelect: () => setEditing(o) },
                    { label: 'Archive', icon: <Archive className="size-4" />, tone: 'danger', onSelect: async () => { if (await confirm({ title: `Archive “${o.name}”?`, body: 'It stops applying to new bills straight away. Bills that already used it are not changed.', confirmLabel: 'Archive offer', cancelLabel: 'Keep offer', tone: 'danger' })) archive.mutate(o.id); } },
                  ]} />
                )}
              </div>
            </Card>
          </li>
        ))}
      </ul>
      {editing && <OfferDrawer offer={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function OfferDrawer({ offer, onClose }: { offer: OfferRow | null; onClose: () => void }) {
  const client = useQueryClient();
  const { branches, timezone } = useBranch();
  const services = useServices();
  const categories = useCategories();
  const [error, setError] = useState<string | null>(null);
  const [pickerKey, setPickerKey] = useState(0);
  const today = todayIn(timezone);
  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(offerSchema),
    defaultValues: {
      name: offer?.name ?? '',
      description: offer?.description ?? '',
      code: offer?.code ?? '',
      discountType: offer?.discountType ?? 'percentage',
      discountValue: offer?.discountValue ?? 1000,
      maxDiscountAmount: offer?.maxDiscountAmount ?? null,
      minBillAmount: offer?.minBillAmount ?? null,
      appliesTo: offer?.appliesTo ?? 'all_services',
      serviceIds: offer?.serviceIds ?? [],
      categoryIds: offer?.categoryIds ?? [],
      eligibility: offer?.eligibility ?? 'all',
      loyaltyMinVisits: offer?.loyaltyMinVisits ?? null,
      loyaltyMinSpend: offer?.loyaltyMinSpend ?? null,
      birthdayWindowDays: offer?.birthdayWindowDays ?? 7,
      customerIds: offer?.customers.map((c) => c.id) ?? [],
      validFrom: offer?.validFrom ?? today,
      validTo: offer?.validTo ?? today,
      validWeekdays: offer?.validWeekdays ?? [],
      allBranches: offer?.allBranches ?? true,
      branchIds: offer?.branchIds ?? [],
      autoApply: offer?.autoApply ?? false,
      usageLimitTotal: offer?.usageLimitTotal ?? null,
      usageLimitPerCustomer: offer?.usageLimitPerCustomer ?? null,
      status: (offer?.status as FormIn['status']) ?? 'active',
    },
  });
  const v = form.watch();
  const errors = form.formState.errors;
  const [chosen, setChosen] = useState<Array<{ id: string; fullName: string }>>(offer?.customers ?? []);
  const set = <K extends keyof FormIn>(key: K, value: FormIn[K]) => form.setValue(key, value as never, { shouldDirty: true, shouldValidate: form.formState.isSubmitted });

  const save = useMutation({
    mutationFn: (body: FormOut) => (offer ? api.put<OfferRow>(`/offers/${offer.id}`, body) : api.post<OfferRow>('/offers', body)),
    onSuccess: () => { void client.invalidateQueries({ queryKey: qk.offers }); toast.success(offer ? 'Offer updated' : 'Offer created'); onClose(); },
    onError: (e) => {
      if (e instanceof ApiError) for (const [path, message] of Object.entries(e.fieldErrors)) form.setError(path as keyof FormIn, { message });
      setError(friendlyError(e).message);
    },
  });
  const submit = form.handleSubmit((body) => { setError(null); save.mutate(body); });
  const weekdays = v.validWeekdays ?? [];

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={offer ? `Edit ${offer.name}` : 'Create offer'} size="lg" persistent footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={save.isPending}>{offer ? 'Save changes' : 'Create offer'}</Button></>}>
      <form onSubmit={submit} className="space-y-5" noValidate>
        <FormError message={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Offer name" required error={errors.name?.message} className="sm:col-span-2"><Input autoFocus placeholder="e.g. Diwali 15% off" {...form.register('name')} /></Field>
          <Field label="How much off?" required error={errors.discountValue?.message}>
            <div className="space-y-2">
              <Segmented label="Type of discount" value={v.discountType ?? 'percentage'} onChange={(t) => { set('discountType', t); set('discountValue', t === 'percentage' ? 1000 : 10000); }} options={[{ value: 'percentage', label: 'Percentage' }, { value: 'flat', label: 'Fixed amount' }]} />
              {v.discountType === 'flat' ? <MoneyInput value={v.discountValue ?? null} onChange={(m) => set('discountValue', m ?? 0)} /> : <Input type="number" min={1} max={100} step={0.5} suffix="%" value={(v.discountValue ?? 0) / 100} onChange={(e) => set('discountValue', Math.round(Number(e.target.value) * 100))} />}
            </div>
          </Field>
          <Field label="Promo code" optional hint="Leave empty if staff should not need to type anything." error={errors.code?.message}><Input className="uppercase" placeholder="e.g. DIWALI15" {...form.register('code')} /></Field>
          {v.discountType === 'percentage' && <Field label="Most you will give off" optional hint="Caps the discount on big bills."><MoneyInput value={v.maxDiscountAmount ?? null} onChange={(m) => set('maxDiscountAmount', m)} /></Field>}
          <Field label="Smallest bill it applies to" optional><MoneyInput value={v.minBillAmount ?? null} onChange={(m) => set('minBillAmount', m)} /></Field>
          <Field label="Starts" required error={errors.validFrom?.message}><DateInput {...form.register('validFrom')} /></Field>
          <Field label="Ends" required error={errors.validTo?.message}><DateInput {...form.register('validTo')} /></Field>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold">Which days?</legend>
          <p className="text-xs text-muted">Leave all unselected to run every day.</p>
          <div className="flex flex-wrap gap-2">
            {WEEKDAYS.map((d) => { const on = weekdays.includes(d); return <button key={d} type="button" aria-pressed={on} onClick={() => set('validWeekdays', on ? weekdays.filter((x) => x !== d) : [...weekdays, d].sort())} className={`rounded-full border px-3 py-1.5 text-sm max-md:min-h-10 ${on ? 'border-primary bg-primary-soft text-primary-soft-fg' : 'border-line hover:border-primary/50'}`}>{WEEKDAY_SHORT[d]}</button>; })}
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="What does it apply to?"><Select value={v.appliesTo} onChange={(e) => set('appliesTo', e.target.value as OfferScope)}>{OFFER_SCOPES.map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}</Select></Field>
          <Field label="Who gets it?"><Select value={v.eligibility} onChange={(e) => set('eligibility', e.target.value as OfferEligibility)}>{OFFER_ELIGIBILITY.map((s) => <option key={s} value={s}>{OFFER_ELIGIBILITY_LABELS[s]}</option>)}</Select></Field>
        </div>
        {(v.appliesTo === 'services' || v.appliesTo === 'combo') && (
          <Field label={v.appliesTo === 'combo' ? 'Services in the combo (at least two)' : 'Services'} required error={errors.serviceIds?.message}><MultiSelectList items={(services.data ?? []).map((s) => ({ id: s.id, label: s.name, hint: s.categoryName }))} selected={v.serviceIds ?? []} onChange={(ids) => set('serviceIds', ids)} /></Field>
        )}
        {v.appliesTo === 'categories' && <Field label="Categories" required error={errors.categoryIds?.message}><MultiSelectList items={(categories.data ?? []).map((c) => ({ id: c.id, label: c.name }))} selected={v.categoryIds ?? []} onChange={(ids) => set('categoryIds', ids)} /></Field>}
        {v.eligibility === 'loyalty' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="At least this many visits" error={errors.loyaltyMinVisits?.message}><Input type="number" min={1} value={v.loyaltyMinVisits ?? ''} onChange={(e) => set('loyaltyMinVisits', e.target.value === '' ? null : Number(e.target.value))} /></Field>
            <Field label="or this much spent"><MoneyInput value={v.loyaltyMinSpend ?? null} onChange={(m) => set('loyaltyMinSpend', m)} /></Field>
          </div>
        )}
        {v.eligibility === 'birthday' && <Field label="Days around the birthday" hint="7 means three days before to three days after, roughly a week."><Input type="number" min={0} max={31} {...form.register('birthdayWindowDays', { valueAsNumber: true })} /></Field>}
        {v.eligibility === 'specific_customers' && (
          <Field label="Customers" required error={errors.customerIds?.message}>
            <div className="space-y-2">
              <CustomerPicker key={pickerKey} value={null} label="Add a customer" onChange={(c) => { if (!c || chosen.some((x) => x.id === c.id)) return; const next = [...chosen, { id: c.id, fullName: c.fullName }]; setChosen(next); set('customerIds', next.map((x) => x.id)); setPickerKey((k) => k + 1); }} />
              <ul className="flex flex-wrap gap-2">{chosen.map((c) => <li key={c.id} className="flex items-center gap-1 rounded-full bg-surface-2 py-1 pl-3 pr-1 text-sm">{c.fullName}<IconButton label={`Remove ${c.fullName}`} size="sm" onClick={() => { const next = chosen.filter((x) => x.id !== c.id); setChosen(next); set('customerIds', next.map((x) => x.id)); }}><X className="size-3.5" /></IconButton></li>)}</ul>
            </div>
          </Field>
        )}

        {branches.length > 1 && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">Where?</legend>
            <Switch checked={!!v.allBranches} onCheckedChange={(x) => set('allBranches', x)} label="At every branch" />
            {!v.allBranches && <><MultiSelectList items={branches.map((b) => ({ id: b.id, label: b.name }))} selected={v.branchIds ?? []} onChange={(ids) => set('branchIds', ids)} /><FormError message={errors.branchIds?.message} /></>}
          </fieldset>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Total times it can be used" optional><Input type="number" min={1} value={v.usageLimitTotal ?? ''} onChange={(e) => set('usageLimitTotal', e.target.value === '' ? null : Number(e.target.value))} /></Field>
          <Field label="Times per customer" optional><Input type="number" min={1} value={v.usageLimitPerCustomer ?? ''} onChange={(e) => set('usageLimitPerCustomer', e.target.value === '' ? null : Number(e.target.value))} /></Field>
        </div>
        <Field label="Notes for the team" optional><Textarea rows={2} {...form.register('description')} /></Field>
        <Switch checked={!!v.autoApply} onCheckedChange={(x) => set('autoApply', x)} label="Apply automatically when it fits" description="Otherwise staff choose it (or type the code) while billing." />
        <Switch checked={v.status === 'active'} onCheckedChange={(x) => set('status', x ? 'active' : 'inactive')} label="Active" description="Switch off to pause without deleting." />
      </form>
    </Drawer>
  );
}
