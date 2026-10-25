import { zodResolver } from '@hookform/resolvers/zod';
import { PACKAGE_SEGMENTS, packageSchema, type PackageSegment } from '@salon/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { toastError } from '@/app/providers';
import { Money, useMoney } from '@/components/common/badges';
import { MultiSelectList } from '@/components/common/MultiSelectList';
import { Button, IconButton } from '@/components/ui/button';
import { Badge, Card, EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui/display';
import { DateInput, Field, FormError, Input, MoneyInput, Select, Switch, Textarea } from '@/components/ui/form';
import { Drawer, Menu, useConfirm } from '@/components/ui/overlay';
import { api, ApiError } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { friendlyError } from '@/lib/errors';
import { qk, useServices } from '@/lib/queries';

type FormIn = z.input<typeof packageSchema>;
type FormOut = z.output<typeof packageSchema>;

interface PackageRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  price: number;
  taxRateBp: number | null;
  validityDays: number;
  allBranches: boolean;
  customerSegment: PackageSegment;
  maxPerCustomer: number | null;
  saleLimitTotal: number | null;
  soldCount: number;
  saleStartsOn: string | null;
  saleEndsOn: string | null;
  status: string;
  items: Array<{ serviceId: string; quantity: number; serviceName: string; servicePrice: number }>;
  originalValue: number;
  savings: number;
  branchIds: string[];
}

const SEGMENT_LABEL: Record<PackageSegment, string> = { all: 'Everyone', new_customers: 'New customers only', existing_customers: 'Existing customers only' };

/** Prepaid bundles ("5 facials for the price of 4") and combos. Bought once, used over several visits. */
export function Component() {
  const manage = useCan()('packages.manage');
  const confirm = useConfirm();
  const client = useQueryClient();
  const [editing, setEditing] = useState<PackageRow | 'new' | null>(null);
  const q = useQuery({ queryKey: qk.packages, queryFn: () => api.get<PackageRow[]>('/packages') });
  const archive = useMutation({ mutationFn: (id: string) => api.delete(`/packages/${id}`), onSuccess: () => { void client.invalidateQueries({ queryKey: qk.packages }); toast.success('Package archived'); }, onError: toastError });

  return (
    <div>
      <PageHeader title="Packages and combos" description="Bundles customers pay for once and use over several visits." actions={manage && <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Create package</Button>} />
      {q.isLoading && <div role="status" aria-label="Loading packages" className="grid gap-3 md:grid-cols-2"><Skeleton className="h-40" /><Skeleton className="h-40" /></div>}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && q.data.length === 0 && <Card><EmptyState title="No packages yet" description="Create a bundle such as “Bridal glow: 3 facials + 2 hair spas”." action={manage && <Button onClick={() => setEditing('new')}>Create package</Button>} /></Card>}
      <ul className="grid gap-3 md:grid-cols-2">
        {q.data?.map((p) => (
          <li key={p.id}>
            <Card className="h-full">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{p.name}</h2><Badge tone={p.status === 'active' ? 'success' : 'neutral'}>{p.status === 'active' ? 'On sale' : 'Paused'}</Badge></div>
                  <p className="mt-1 text-xl font-semibold"><Money value={p.price} />{p.savings > 0 && <span className="ml-2 text-sm font-normal text-success">Saves <Money value={p.savings} /></span>}</p>
                  <ul className="mt-2 space-y-0.5 text-sm text-muted">{p.items.map((i) => <li key={i.serviceId}>{i.quantity} × {i.serviceName}</li>)}</ul>
                  <p className="mt-2 text-xs text-muted">Valid {p.validityDays} days from purchase · {SEGMENT_LABEL[p.customerSegment]} · {p.soldCount} sold{p.saleLimitTotal ? ` of ${p.saleLimitTotal}` : ''}</p>
                </div>
                {manage && (
                  <Menu label={`Actions for ${p.name}`} trigger={<IconButton label={`Actions for ${p.name}`} size="sm"><MoreHorizontal className="size-5" /></IconButton>} items={[
                    { label: 'Edit', icon: <Pencil className="size-4" />, onSelect: () => setEditing(p) },
                    { label: 'Archive', icon: <Archive className="size-4" />, tone: 'danger', onSelect: async () => { if (await confirm({ title: `Archive “${p.name}”?`, body: 'It can no longer be sold. Customers who already bought it keep their remaining sessions.', confirmLabel: 'Archive package', cancelLabel: 'Keep package', tone: 'danger' })) archive.mutate(p.id); } },
                  ]} />
                )}
              </div>
            </Card>
          </li>
        ))}
      </ul>
      {editing && <PackageDrawer pkg={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function PackageDrawer({ pkg, onClose }: { pkg: PackageRow | null; onClose: () => void }) {
  const client = useQueryClient();
  const { branches } = useBranch();
  const money = useMoney();
  const services = useServices();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(packageSchema),
    defaultValues: {
      code: pkg?.code ?? '',
      name: pkg?.name ?? '',
      description: pkg?.description ?? '',
      price: pkg?.price ?? 0,
      taxRateBp: pkg?.taxRateBp ?? null,
      validityDays: pkg?.validityDays ?? 180,
      items: pkg?.items.map((i) => ({ serviceId: i.serviceId, quantity: i.quantity })) ?? [],
      allBranches: pkg?.allBranches ?? true,
      branchIds: pkg?.branchIds ?? [],
      customerSegment: pkg?.customerSegment ?? 'all',
      maxPerCustomer: pkg?.maxPerCustomer ?? null,
      saleLimitTotal: pkg?.saleLimitTotal ?? null,
      saleStartsOn: pkg?.saleStartsOn ?? '',
      saleEndsOn: pkg?.saleEndsOn ?? '',
      status: (pkg?.status as FormIn['status']) ?? 'active',
    },
  });
  const v = form.watch();
  const errors = form.formState.errors;
  const set = <K extends keyof FormIn>(key: K, value: FormIn[K]) => form.setValue(key, value as never, { shouldDirty: true, shouldValidate: form.formState.isSubmitted });
  const items = v.items ?? [];
  const byId = new Map((services.data ?? []).map((s) => [s.id, s]));
  const original = items.reduce((a, i) => a + (byId.get(i.serviceId)?.price ?? 0) * i.quantity, 0);
  const unused = (services.data ?? []).filter((s) => !items.some((i) => i.serviceId === s.id));

  const save = useMutation({
    mutationFn: (body: FormOut) => (pkg ? api.put<PackageRow>(`/packages/${pkg.id}`, body) : api.post<PackageRow>('/packages', body)),
    onSuccess: () => { void client.invalidateQueries({ queryKey: qk.packages }); toast.success(pkg ? 'Package updated' : 'Package created'); onClose(); },
    onError: (e) => {
      if (e instanceof ApiError) for (const [path, message] of Object.entries(e.fieldErrors)) form.setError(path as keyof FormIn, { message });
      setError(friendlyError(e).message);
    },
  });
  const submit = form.handleSubmit((body) => { setError(null); save.mutate(body); });

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={pkg ? `Edit ${pkg.name}` : 'Create package'} size="lg" persistent footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={save.isPending}>{pkg ? 'Save changes' : 'Create package'}</Button></>}>
      <form onSubmit={submit} className="space-y-5" noValidate>
        <FormError message={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Package name" required error={errors.name?.message} className="sm:col-span-2"><Input autoFocus placeholder="e.g. Bridal glow" {...form.register('name')} /></Field>
          <Field label="Short code" required error={errors.code?.message}><Input className="uppercase" {...form.register('code')} /></Field>
          <Field label="Valid for (days)" required error={errors.validityDays?.message} hint="Counted from the day it is bought."><Input type="number" min={1} {...form.register('validityDays', { valueAsNumber: true })} /></Field>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold">What is included?</legend>
          {items.length === 0 && <p className="text-sm text-muted">Add the services in this package.</p>}
          <ul className="space-y-2">
            {items.map((item, idx) => (
              <li key={item.serviceId} className="flex items-center gap-3 rounded-lg border border-line p-2.5">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{byId.get(item.serviceId)?.name ?? 'Service'}</span>
                <label className="flex items-center gap-2 text-sm text-muted">Times<Input type="number" min={1} max={100} className="w-20" aria-label={`Times for ${byId.get(item.serviceId)?.name ?? 'service'}`} value={item.quantity} onChange={(e) => set('items', items.map((x, i) => (i === idx ? { ...x, quantity: Math.max(1, Number(e.target.value) || 1) } : x)))} /></label>
                <IconButton label="Remove from package" size="sm" onClick={() => set('items', items.filter((_, i) => i !== idx))}><Trash2 className="size-4" /></IconButton>
              </li>
            ))}
          </ul>
          <Select aria-label="Add a service" value="" onChange={(e) => e.target.value && set('items', [...items, { serviceId: e.target.value, quantity: 1 }])}><option value="">Add a service…</option>{unused.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
          <FormError message={errors.items?.message ?? (errors.items as { root?: { message?: string } } | undefined)?.root?.message} />
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Package price" required error={errors.price?.message} hint={original > 0 ? `Bought separately these cost ${money(original)}.` : undefined}><MoneyInput value={v.price ?? 0} onChange={(m) => set('price', m ?? 0)} /></Field>
          <Field label="Tax rate" optional hint="Leave empty to use the salon’s default."><Input type="number" min={0} max={100} step={0.5} suffix="%" value={v.taxRateBp == null ? '' : v.taxRateBp / 100} onChange={(e) => set('taxRateBp', e.target.value === '' ? null : Math.round(Number(e.target.value) * 100))} /></Field>
          <Field label="Who can buy it?"><Select value={v.customerSegment} onChange={(e) => set('customerSegment', e.target.value as PackageSegment)}>{PACKAGE_SEGMENTS.map((s) => <option key={s} value={s}>{SEGMENT_LABEL[s]}</option>)}</Select></Field>
          <Field label="Most one customer can buy" optional><Input type="number" min={1} value={v.maxPerCustomer ?? ''} onChange={(e) => set('maxPerCustomer', e.target.value === '' ? null : Number(e.target.value))} /></Field>
          <Field label="Total available to sell" optional><Input type="number" min={1} value={v.saleLimitTotal ?? ''} onChange={(e) => set('saleLimitTotal', e.target.value === '' ? null : Number(e.target.value))} /></Field>
          <span />
          <Field label="On sale from" optional><DateInput {...form.register('saleStartsOn')} /></Field>
          <Field label="On sale until" optional><DateInput {...form.register('saleEndsOn')} /></Field>
        </div>
        <Field label="Description" optional><Textarea rows={2} {...form.register('description')} /></Field>

        {branches.length > 1 && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">Where is it sold?</legend>
            <Switch checked={!!v.allBranches} onCheckedChange={(x) => set('allBranches', x)} label="At every branch" />
            {!v.allBranches && <><MultiSelectList items={branches.map((b) => ({ id: b.id, label: b.name }))} selected={v.branchIds ?? []} onChange={(ids) => set('branchIds', ids)} /><FormError message={errors.branchIds?.message} /></>}
          </fieldset>
        )}
        <Switch checked={v.status === 'active'} onCheckedChange={(x) => set('status', x ? 'active' : 'inactive')} label="On sale" description="Switch off to pause sales without deleting." />
      </form>
    </Drawer>
  );
}
