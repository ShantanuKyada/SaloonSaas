import { zodResolver } from '@hookform/resolvers/zod';
import { WEEKDAYS, WEEKDAY_LABELS, branchHoursSchema, branchSchema, holidaySchema } from '@salon/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, MapPin, Pencil, Phone, Plus, Trash2, User } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { toastError } from '@/app/providers';
import { Button, IconButton } from '@/components/ui/button';
import { Badge, Card, CardHeader, EmptyState, ErrorState, InlineNotice, PageHeader, Skeleton, TabPanel, Tabs } from '@/components/ui/display';
import { DateInput, Field, FormError, Input, Select, Switch, TimeInput } from '@/components/ui/form';
import { Drawer, Modal } from '@/components/ui/overlay';
import { api, ApiError } from '@/lib/api';
import { useAuth, useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { friendlyError } from '@/lib/errors';
import { fmtDay, todayIn } from '@/lib/format';
import { withCurrent } from '@/lib/timezones';

interface BranchRow {
  id: string; code: string; name: string; addressLine1: string | null; addressLine2: string | null; city: string | null; state: string | null; postalCode: string | null; phone: string | null; email: string | null;
  timezone: string; managerUserId: string | null; managerName: string | null; status: string;
  hours: Array<{ weekday: number; isClosed: boolean; openTime: string | null; closeTime: string | null }>;
}
interface Holiday { id: string; date: string; name: string; branchId: string | null; branchName: string | null }
type FormIn = z.input<typeof branchSchema>;
type FormOut = z.output<typeof branchSchema>;

const summariseHours = (b: BranchRow) => {
  const open = b.hours.filter((h) => !h.isClosed);
  if (open.length === 0) return 'Closed every day';
  const first = open[0]!;
  const same = open.every((h) => h.openTime === first.openTime && h.closeTime === first.closeTime);
  const closed = b.hours.filter((h) => h.isClosed).map((h) => WEEKDAY_LABELS[h.weekday]!.slice(0, 3));
  return `${same ? `${first.openTime}–${first.closeTime}` : 'Hours vary by day'}${closed.length ? ` · closed ${closed.join(', ')}` : ' · open daily'}`;
};

export function Component() {
  const [tab, setTab] = useState('branches');
  return (
    <div>
      <PageHeader title="Branches" description="Locations, opening hours and holidays." />
      <Tabs value={tab} onValueChange={setTab} tabs={[{ value: 'branches', label: 'Branches' }, { value: 'holidays', label: 'Holidays' }]}>
        <TabPanel value="branches"><BranchList /></TabPanel>
        <TabPanel value="holidays"><Holidays /></TabPanel>
      </Tabs>
    </div>
  );
}

function BranchList() {
  const manage = useCan()('branches.manage');
  const [editing, setEditing] = useState<BranchRow | 'new' | null>(null);
  const [hoursFor, setHoursFor] = useState<BranchRow | null>(null);
  const q = useQuery({ queryKey: ['branches', 'full'], queryFn: () => api.get<BranchRow[]>('/branches') });
  return (
    <div className="space-y-4">
      {manage && <div className="flex justify-end"><Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Add branch</Button></div>}
      {q.isLoading && <div role="status" aria-label="Loading branches" className="grid gap-4 md:grid-cols-2"><Skeleton className="h-44" /><Skeleton className="h-44" /></div>}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      <ul className="grid gap-4 md:grid-cols-2">
        {q.data?.map((b) => (
          <li key={b.id}>
            <Card className="h-full">
              <div className="flex items-start justify-between gap-3">
                <div><h2 className="text-lg font-semibold">{b.name}</h2><p className="text-sm text-muted">Code {b.code}</p></div>
                <Badge tone={b.status === 'active' ? 'success' : 'neutral'}>{b.status === 'active' ? 'Open for business' : 'Inactive'}</Badge>
              </div>
              <ul className="mt-3 space-y-1.5 text-sm">
                <li className="flex gap-2"><MapPin className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />{[b.addressLine1, b.addressLine2, b.city, b.state, b.postalCode].filter(Boolean).join(', ') || <span className="text-muted">No address yet</span>}</li>
                {b.phone && <li className="flex gap-2"><Phone className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />{b.phone}</li>}
                <li className="flex gap-2"><Clock className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />{summariseHours(b)}</li>
                {b.managerName && <li className="flex gap-2"><User className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />Managed by {b.managerName}</li>}
              </ul>
              {manage && <div className="mt-4 flex gap-2"><Button size="sm" variant="outline" icon={<Pencil className="size-4" />} onClick={() => setEditing(b)}>Edit details</Button><Button size="sm" variant="outline" icon={<Clock className="size-4" />} onClick={() => setHoursFor(b)}>Opening hours</Button></div>}
            </Card>
          </li>
        ))}
      </ul>
      {editing && <BranchDrawer branch={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {hoursFor && <HoursDrawer branch={hoursFor} onClose={() => setHoursFor(null)} />}
    </div>
  );
}

function useRefreshBranches() {
  const client = useQueryClient();
  const { reloadUser } = useAuth();
  return async () => {
    await client.invalidateQueries({ queryKey: ['branches'] });
    await client.invalidateQueries({ queryKey: ['calendar'] });
    await reloadUser();
  };
}

function BranchDrawer({ branch, onClose }: { branch: BranchRow | null; onClose: () => void }) {
  const refresh = useRefreshBranches();
  const canUsers = useCan()('users.manage');
  const { timezone } = useBranch();
  const [error, setError] = useState<string | null>(null);
  const users = useQuery({ queryKey: ['users', 'managers'], queryFn: () => api.list<{ id: string; fullName: string; roleName: string }>('/users', { status: 'active', pageSize: 100 }), enabled: canUsers });
  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(branchSchema),
    defaultValues: { name: branch?.name ?? '', code: branch?.code ?? '', addressLine1: branch?.addressLine1 ?? '', addressLine2: branch?.addressLine2 ?? '', city: branch?.city ?? '', state: branch?.state ?? '', postalCode: branch?.postalCode ?? '', phone: branch?.phone ?? '', email: branch?.email ?? '', timezone: branch?.timezone ?? timezone, managerUserId: branch?.managerUserId ?? '', status: (branch?.status as FormIn['status']) ?? 'active' },
  });
  const errors = form.formState.errors;
  const save = useMutation({
    mutationFn: (body: FormOut) => (branch ? api.put(`/branches/${branch.id}`, body) : api.post('/branches', body)),
    onSuccess: async () => { await refresh(); toast.success(branch ? 'Branch updated' : 'Branch added. Opening hours were copied from your first branch.'); onClose(); },
    onError: (e) => {
      if (e instanceof ApiError) for (const [path, message] of Object.entries(e.fieldErrors)) form.setError(path as keyof FormIn, { message });
      setError(friendlyError(e).message);
    },
  });
  const submit = form.handleSubmit((body) => { setError(null); save.mutate(body); });
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={branch ? `Edit ${branch.name}` : 'Add branch'} size="lg" persistent footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={save.isPending}>{branch ? 'Save changes' : 'Add branch'}</Button></>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormError message={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Branch name" required error={errors.name?.message}><Input autoFocus placeholder="e.g. Rajkot" {...form.register('name')} /></Field>
          <Field label="Short code" required error={errors.code?.message} hint="2–10 letters or numbers. Appears on bill numbers."><Input className="uppercase" {...form.register('code')} /></Field>
          <Field label="Address" optional className="sm:col-span-2"><Input {...form.register('addressLine1')} /></Field>
          <Field label="Area / landmark" optional className="sm:col-span-2"><Input {...form.register('addressLine2')} /></Field>
          <Field label="City" optional><Input {...form.register('city')} /></Field>
          <Field label="State" optional><Input {...form.register('state')} /></Field>
          <Field label="PIN / postal code" optional><Input {...form.register('postalCode')} /></Field>
          <Field label="Phone" optional error={errors.phone?.message}><Input type="tel" {...form.register('phone')} /></Field>
          <Field label="Email" optional error={errors.email?.message}><Input type="email" {...form.register('email')} /></Field>
          <Field label="Time zone" required error={errors.timezone?.message}><Select {...form.register('timezone')}>{withCurrent(branch?.timezone ?? timezone).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</Select></Field>
          {canUsers && <Field label="Branch manager" optional><Select {...form.register('managerUserId')}><option value="">No manager assigned</option>{(users.data?.rows ?? []).map((u) => <option key={u.id} value={u.id}>{u.fullName} ({u.roleName})</option>)}</Select></Field>}
          <Field label="Status"><Select {...form.register('status')}><option value="active">Open for business</option><option value="inactive">Inactive (hidden from booking)</option></Select></Field>
        </div>
        {branch && branch.timezone !== form.watch('timezone') && <InlineNotice tone="warning" title="Changing the time zone">Existing appointments keep their exact moment in time, but they will display in the new zone.</InlineNotice>}
      </form>
    </Drawer>
  );
}

function HoursDrawer({ branch, onClose }: { branch: BranchRow; onClose: () => void }) {
  const refresh = useRefreshBranches();
  const [hours, setHours] = useState(() => WEEKDAYS.map((d) => { const h = branch.hours.find((x) => x.weekday === d); return { weekday: d, isClosed: h?.isClosed ?? false, openTime: h?.openTime ?? '10:00', closeTime: h?.closeTime ?? '20:00' }; }));
  const [error, setError] = useState<string | null>(null);
  const patch = (d: number, p: Partial<(typeof hours)[number]>) => { setHours((x) => x.map((h) => (h.weekday === d ? { ...h, ...p } : h))); setError(null); };
  const save = useMutation({
    mutationFn: () => {
      const parsed = branchHoursSchema.safeParse({ hours });
      if (!parsed.success) throw new Error('Opening time must be before closing time on every open day.');
      return api.put(`/branches/${branch.id}/hours`, parsed.data);
    },
    onSuccess: async () => { await refresh(); toast.success('Opening hours saved'); onClose(); },
    onError: (e) => setError(e instanceof Error && !(e instanceof ApiError) ? e.message : friendlyError(e).message),
  });
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={`${branch.name}: opening hours`} description="Customers can only book inside these hours." persistent footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate()}>Save hours</Button></>}>
      <div className="space-y-3">
        <FormError message={error} />
        <ul className="space-y-2">
          {hours.map((h) => (
            <li key={h.weekday} className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3">
              <div className="w-32"><Switch checked={!h.isClosed} onCheckedChange={(open) => patch(h.weekday, { isClosed: !open })} label={WEEKDAY_LABELS[h.weekday]!} /></div>
              {h.isClosed ? <span className="text-sm text-muted">Closed</span> : <div className="flex items-center gap-2"><TimeInput aria-label={`${WEEKDAY_LABELS[h.weekday]} opens`} value={h.openTime ?? ''} onChange={(e) => patch(h.weekday, { openTime: e.target.value })} className="w-28" /><span className="text-muted">to</span><TimeInput aria-label={`${WEEKDAY_LABELS[h.weekday]} closes`} value={h.closeTime ?? ''} onChange={(e) => patch(h.weekday, { closeTime: e.target.value })} className="w-28" /></div>}
            </li>
          ))}
        </ul>
        <Button variant="ghost" size="sm" onClick={() => { const first = hours.find((h) => !h.isClosed); if (first) setHours((x) => x.map((h) => (h.isClosed ? h : { ...h, openTime: first.openTime, closeTime: first.closeTime }))); }}>Use the first open day’s hours for all open days</Button>
      </div>
    </Drawer>
  );
}

function Holidays() {
  const manage = useCan()('branches.manage');
  const client = useQueryClient();
  const { branches, timezone } = useBranch();
  const today = todayIn(timezone);
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: ['holidays', 'all', today], queryFn: () => api.get<Holiday[]>('/holidays', { from: today }) });
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/holidays/${id}`), onSuccess: () => { void client.invalidateQueries({ queryKey: ['holidays'] }); void client.invalidateQueries({ queryKey: ['calendar'] }); void client.invalidateQueries({ queryKey: ['availability'] }); toast.success('Holiday removed'); }, onError: toastError });
  return (
    <Card>
      <CardHeader title="Upcoming holidays" description="The salon is closed for bookings on these days." actions={manage && <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add holiday</Button>} />
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} compact />}
      {q.data?.length === 0 && <EmptyState title="No upcoming holidays" description="Add festivals and closures so nobody can book those days." />}
      <ul className="divide-y divide-line">
        {q.data?.map((h) => (
          <li key={h.id} className="flex items-center gap-3 py-2.5"><div className="min-w-0 flex-1"><p className="font-medium">{h.name}</p><p className="text-sm text-muted">{fmtDay(h.date, timezone, true)} · {h.branchName ?? 'All branches'}</p></div>{manage && <IconButton label={`Remove ${h.name}`} size="sm" onClick={() => remove.mutate(h.id)}><Trash2 className="size-4" /></IconButton>}</li>
        ))}
      </ul>
      {adding && <AddHoliday branches={branches} today={today} onClose={() => setAdding(false)} />}
    </Card>
  );
}

function AddHoliday({ branches, today, onClose }: { branches: Array<{ id: string; name: string }>; today: string; onClose: () => void }) {
  const client = useQueryClient();
  const [v, setV] = useState({ date: today, name: '', branchId: '' });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => { const parsed = holidaySchema.safeParse(v); if (!parsed.success) throw new Error('Enter the holiday’s name.'); return api.post('/holidays', parsed.data); },
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['holidays'] }); void client.invalidateQueries({ queryKey: ['calendar'] }); void client.invalidateQueries({ queryKey: ['availability'] }); toast.success('Holiday added'); onClose(); },
    onError: (e) => setError(e instanceof Error && !(e instanceof ApiError) ? e.message : friendlyError(e).message),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Add holiday" size="sm" footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate()}>Add holiday</Button></>}>
      <div className="space-y-4">
        <FormError message={error} />
        <Field label="Date" required><DateInput value={v.date} min={today} onChange={(e) => setV({ ...v, date: e.target.value })} /></Field>
        <Field label="Name" required><Input value={v.name} placeholder="e.g. Diwali" onChange={(e) => { setV({ ...v, name: e.target.value }); setError(null); }} /></Field>
        {branches.length > 1 && <Field label="Applies to"><Select value={v.branchId} onChange={(e) => setV({ ...v, branchId: e.target.value })}><option value="">All branches</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>}
        <p className="text-xs text-muted">Appointments already booked on that day stay on the calendar so you can move or cancel them.</p>
      </div>
    </Modal>
  );
}
