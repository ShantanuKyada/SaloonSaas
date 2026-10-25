import { zodResolver } from '@hookform/resolvers/zod';
import { SERVICE_GENDERS, serviceSchema, type ServiceDto } from '@salon/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, MoreHorizontal, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { toast } from 'sonner';
import { toastError } from '@/app/providers';
import { Money } from '@/components/common/badges';
import { Button, IconButton } from '@/components/ui/button';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui/display';
import { Checkbox, Field, FormError, Input, MoneyInput, Select, Switch, Textarea } from '@/components/ui/form';
import { Drawer, Menu, useConfirm } from '@/components/ui/overlay';
import { DataTable, type Column } from '@/components/ui/table';
import { api, ApiError } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { fmtDuration } from '@/lib/format';
import { friendlyError } from '@/lib/errors';
import { qk, useCategories, useExpertise, useServices } from '@/lib/queries';

type FormIn = z.input<typeof serviceSchema>;
type FormOut = z.output<typeof serviceSchema>;

export function Component() {
  const can = useCan();
  const manage = can('services.manage');
  const confirm = useConfirm();
  const client = useQueryClient();
  const [editing, setEditing] = useState<ServiceDto | 'new' | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const q = useServices(undefined, { includeInactive: showInactive });
  const rows = q.data ?? [];

  const archive = useMutation({ mutationFn: (id: string) => api.delete(`/services/${id}`), onSuccess: () => { void client.invalidateQueries({ queryKey: ['services'] }); toast.success('Service archived'); }, onError: toastError });

  const columns: Array<Column<ServiceDto>> = [
    { key: 'name', header: 'Service', mobile: 'title', cell: (s) => <div><p className="font-medium">{s.name}</p><p className="text-xs text-muted">{s.code}</p></div> },
    { key: 'cat', header: 'Category', hideBelow: 'md', cell: (s) => <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full" style={{ background: s.categoryColor }} aria-hidden />{s.categoryName}</span> },
    { key: 'dur', header: 'Time', cell: (s) => fmtDuration(s.durationMinutes) },
    { key: 'price', header: 'Price', align: 'right', cell: (s) => <Money value={s.price} /> },
    { key: 'team', header: 'Team members', align: 'right', hideBelow: 'lg', cell: (s) => (s.qualifiedStaffCount === 0 ? <Badge tone="warning">Nobody yet</Badge> : s.qualifiedStaffCount) },
    { key: 'booked', header: 'Booked (30 days)', align: 'right', hideBelow: 'lg', cell: (s) => s.bookingsLast30Days ?? 0 },
    { key: 'status', header: 'Status', hideBelow: 'md', cell: (s) => <Badge tone={s.status === 'active' ? 'success' : 'neutral'}>{s.status === 'active' ? 'Active' : 'Inactive'}</Badge> },
    {
      key: 'actions',
      header: 'Actions',
      srOnlyHeader: true,
      mobile: 'hide',
      align: 'right',
      cell: (s) => manage && (
        <span onClick={(e) => e.stopPropagation()}>
          <Menu label={`Actions for ${s.name}`} trigger={<IconButton label="Actions" size="sm"><MoreHorizontal className="size-5" /></IconButton>} items={[
            { label: 'Edit', icon: <Pencil className="size-4" />, onSelect: () => setEditing(s) },
            { label: 'Archive', icon: <Archive className="size-4" />, tone: 'danger', onSelect: async () => { if (await confirm({ title: `Archive “${s.name}”?`, body: 'It will no longer be offered for new bookings or bills. Past bookings and bills keep it.', confirmLabel: 'Archive service', cancelLabel: 'Keep service', tone: 'danger' })) archive.mutate(s.id); } },
          ]} />
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="Services" description="Everything you offer, with price and time." actions={manage && <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Add service</Button>} />
      <Card padded={false}>
        <div className="flex items-center justify-between border-b border-line p-4"><p className="text-sm text-muted">{rows.length} {rows.length === 1 ? 'service' : 'services'}</p><Checkbox checked={showInactive} onCheckedChange={setShowInactive} label="Show inactive" /></div>
        <DataTable columns={columns} rows={rows} loading={q.isLoading} error={q.isError ? q.error : undefined} onRetry={() => void q.refetch()} rowKey={(s) => s.id} onRowClick={manage ? (s) => setEditing(s) : undefined} empty={<EmptyState title="No services yet" description="Add the services your salon offers so they can be booked and billed." action={manage && <Button onClick={() => setEditing('new')}>Add service</Button>} />} />
      </Card>
      {editing && <ServiceDrawer service={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ServiceDrawer({ service, onClose }: { service: ServiceDto | null; onClose: () => void }) {
  const client = useQueryClient();
  const { branches } = useBranch();
  const categories = useCategories();
  const expertise = useExpertise();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(serviceSchema),
    defaultValues: {
      categoryId: service?.categoryId ?? '',
      code: service?.code ?? '',
      name: service?.name ?? '',
      description: service?.description ?? '',
      durationMinutes: service?.durationMinutes ?? 30,
      bufferMinutes: service?.bufferMinutes ?? 0,
      price: service?.price ?? 0,
      taxRateBp: service?.taxRateBp ?? null,
      gender: (service?.gender as FormIn['gender']) ?? 'unisex',
      allBranches: service?.allBranches ?? true,
      branches: service?.branches ?? [],
      expertiseIds: service?.expertiseIds ?? [],
      onlineBookable: service?.onlineBookable ?? true,
      status: (service?.status as FormIn['status']) ?? 'active',
    },
  });
  const v = form.watch();
  const errors = form.formState.errors;
  const save = useMutation({
    mutationFn: (body: FormOut) => (service ? api.put<ServiceDto>(`/services/${service.id}`, body) : api.post<ServiceDto>('/services', body)),
    onSuccess: (s) => { void client.invalidateQueries({ queryKey: ['services'] }); void client.invalidateQueries({ queryKey: qk.staff() }); toast.success(service ? 'Service updated' : `${s.name} added`); onClose(); },
    onError: (e) => {
      if (e instanceof ApiError) for (const [path, message] of Object.entries(e.fieldErrors)) form.setError(path as keyof FormIn, { message });
      setError(friendlyError(e).message);
    },
  });
  const submit = form.handleSubmit((body) => { setError(null); save.mutate(body); });
  const toggleExpertise = (id: string) => form.setValue('expertiseIds', v.expertiseIds?.includes(id) ? v.expertiseIds.filter((x) => x !== id) : [...(v.expertiseIds ?? []), id], { shouldDirty: true });
  const branchRow = (id: string) => (v.branches ?? []).find((b) => b.branchId === id);

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={service ? `Edit ${service.name}` : 'Add service'} size="lg" persistent footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={save.isPending}>{service ? 'Save changes' : 'Add service'}</Button></>}>
      <form onSubmit={submit} className="space-y-5" noValidate>
        <FormError message={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Service name" required error={errors.name?.message} className="sm:col-span-2"><Input autoFocus placeholder="e.g. Hair Spa" {...form.register('name')} /></Field>
          <Field label="Category" required error={errors.categoryId?.message}><Select {...form.register('categoryId')}><option value="">Choose…</option>{(categories.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
          <Field label="Short code" required error={errors.code?.message} hint="Used on reports, e.g. HSPA."><Input {...form.register('code')} /></Field>
          <Field label="Time it takes (minutes)" required error={errors.durationMinutes?.message}><Input type="number" min={5} step={5} {...form.register('durationMinutes', { valueAsNumber: true })} /></Field>
          <Field label="Clean-up time after (minutes)" optional hint="Time before the next customer."><Input type="number" min={0} step={5} {...form.register('bufferMinutes', { valueAsNumber: true })} /></Field>
          <Field label="Price" required error={errors.price?.message}><MoneyInput value={v.price ?? 0} onChange={(m) => form.setValue('price', m ?? 0, { shouldDirty: true })} /></Field>
          <Field label="Tax rate" optional hint="Leave empty to use the salon’s default."><Input type="number" min={0} max={100} step={0.5} suffix="%" value={v.taxRateBp == null ? '' : v.taxRateBp / 100} onChange={(e) => form.setValue('taxRateBp', e.target.value === '' ? null : Math.round(Number(e.target.value) * 100), { shouldDirty: true })} /></Field>
          <Field label="For" optional><Select {...form.register('gender')}>{SERVICE_GENDERS.map((g) => <option key={g} value={g}>{g === 'unisex' ? 'Everyone' : g === 'female' ? 'Women' : 'Men'}</option>)}</Select></Field>
          <Field label="Status"><Select {...form.register('status')}><option value="active">Active</option><option value="inactive">Inactive (hidden from booking)</option></Select></Field>
          <Field label="Description" optional className="sm:col-span-2"><Textarea rows={2} {...form.register('description')} /></Field>
        </div>

        <fieldset>
          <legend className="text-sm font-semibold">Who can do it?</legend>
          <p className="mb-2 text-xs text-muted">Team members with any of these skills are suggested automatically. You can fine-tune per person under Team → Assign services.</p>
          <div className="flex flex-wrap gap-2">
            {(expertise.data ?? []).map((e) => { const on = v.expertiseIds?.includes(e.id); return <button key={e.id} type="button" aria-pressed={on} onClick={() => toggleExpertise(e.id)} className={`rounded-full border px-3 py-1.5 text-sm max-md:min-h-10 ${on ? 'border-primary bg-primary-soft text-primary-soft-fg' : 'border-line hover:border-primary/50'}`}>{e.name}</button>; })}
          </div>
        </fieldset>

        {branches.length > 1 && (
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold">Where is it offered?</legend>
            <Switch checked={!!v.allBranches} onCheckedChange={(x) => form.setValue('allBranches', x, { shouldDirty: true })} label="At every branch" />
            {!v.allBranches && (
              <ul className="space-y-2">
                {branches.map((b) => {
                  const row = branchRow(b.id);
                  return (
                    <li key={b.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-3">
                      <Checkbox checked={!!row} onCheckedChange={(on) => form.setValue('branches', on ? [...(v.branches ?? []), { branchId: b.id, priceOverride: null }] : (v.branches ?? []).filter((x) => x.branchId !== b.id), { shouldDirty: true })} label={b.name} />
                      {row && <div className="ml-auto w-44"><MoneyInput value={row.priceOverride ?? null} placeholder="Same price" onChange={(m) => form.setValue('branches', (v.branches ?? []).map((x) => (x.branchId === b.id ? { ...x, priceOverride: m } : x)), { shouldDirty: true })} /></div>}
                    </li>
                  );
                })}
              </ul>
            )}
            <FormError message={errors.branches?.message} />
          </fieldset>
        )}
        <Switch checked={!!v.onlineBookable} onCheckedChange={(x) => form.setValue('onlineBookable', x, { shouldDirty: true })} label="Customers can book it online" />
      </form>
    </Drawer>
  );
}
