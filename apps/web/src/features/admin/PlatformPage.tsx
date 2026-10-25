import { createOrganizationSchema } from '@salon/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, ErrorState, InlineNotice, PageHeader, Skeleton, StatCard, type Tone } from '@/components/ui/display';
import { Field, FormError, Input, SearchInput, Select, Switch } from '@/components/ui/form';
import { Drawer } from '@/components/ui/overlay';
import { DataTable, type Column } from '@/components/ui/table';
import { api, ApiError } from '@/lib/api';
import { friendlyError } from '@/lib/errors';
import { fmtDateTime } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { withCurrent } from '@/lib/timezones';

interface Overview { activeOrganizations: number; suspendedOrganizations: number; activeBranches: number; activeUsers: number; customers: number; appointmentsLast30Days: number }
interface OrgRow { id: string; code: string; name: string; email: string | null; phone: string | null; status: string; subscriptionPlan: string; subscriptionStatus: string; trialEndsAt: string | null; createdAt: string; onboardingCompletedAt: string | null; branchCount: number; userCount: number; customerCount: number; lastActivityAt: string | null }
interface OrgDetail extends OrgRow { maxBranches: number | null; branches: Array<{ id: string; code: string; name: string; city: string | null; status: string }>; owners: Array<{ id: string; fullName: string; email: string | null; phone: string | null; lastLoginAt: string | null; status: string }> }

const STATUS: Record<string, { label: string; tone: Tone }> = { active: { label: 'Active', tone: 'success' }, suspended: { label: 'Suspended', tone: 'danger' }, archived: { label: 'Archived', tone: 'neutral' } };
const PLANS = ['trial', 'starter', 'growth', 'enterprise'] as const;
const SUB = ['trialing', 'active', 'past_due', 'cancelled'] as const;
const SUB_LABEL: Record<string, string> = { trialing: 'In trial', active: 'Paid and active', past_due: 'Payment overdue', cancelled: 'Cancelled' };

/** The platform operator’s home: every salon on the system, trial and plan status, and onboarding of new ones. */
export function Component() {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const term = useDebounced(search);
  const overview = useQuery({ queryKey: ['platform', 'overview'], queryFn: () => api.get<Overview>('/platform/overview') });
  const q = useQuery({ queryKey: ['platform', 'orgs', term, page], queryFn: () => api.list<OrgRow>('/platform/organizations', { search: term || undefined, page, pageSize: 25 }), placeholderData: (p) => p });
  const o = overview.data;
  const columns: Array<Column<OrgRow>> = [
    { key: 'name', header: 'Salon', mobile: 'title', cell: (r) => <div><p className="font-medium">{r.name}</p><p className="text-xs text-muted">{r.code}{r.email ? ` · ${r.email}` : ''}</p></div> },
    { key: 'status', header: 'Status', cell: (r) => <Badge tone={STATUS[r.status]?.tone ?? 'neutral'}>{STATUS[r.status]?.label ?? r.status}</Badge> },
    { key: 'plan', header: 'Plan', hideBelow: 'md', cell: (r) => <span className="capitalize">{r.subscriptionPlan}</span> },
    { key: 'branches', header: 'Branches', align: 'right', hideBelow: 'md', cell: (r) => r.branchCount },
    { key: 'users', header: 'Users', align: 'right', hideBelow: 'lg', cell: (r) => r.userCount },
    { key: 'customers', header: 'Customers', align: 'right', hideBelow: 'lg', cell: (r) => r.customerCount.toLocaleString('en-IN') },
    { key: 'active', header: 'Last booking', hideBelow: 'lg', cell: (r) => (r.lastActivityAt ? fmtDateTime(r.lastActivityAt, 'Asia/Kolkata') : <span className="text-muted">Never</span>) },
    { key: 'setup', header: 'Setup', hideBelow: 'lg', cell: (r) => (r.onboardingCompletedAt ? <Badge tone="success">Complete</Badge> : <Badge tone="warning">In progress</Badge>) },
  ];
  return (
    <div className="space-y-5">
      <PageHeader title="Platform" description="All salons on the system." actions={<Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Add a salon</Button>} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <StatCard label="Active salons" value={o?.activeOrganizations ?? '…'} loading={overview.isLoading} />
        <StatCard label="Suspended" value={o?.suspendedOrganizations ?? '…'} loading={overview.isLoading} tone={o?.suspendedOrganizations ? 'warning' : 'neutral'} />
        <StatCard label="Branches" value={o?.activeBranches ?? '…'} loading={overview.isLoading} />
        <StatCard label="Users" value={o?.activeUsers ?? '…'} loading={overview.isLoading} />
        <StatCard label="Customers" value={o ? o.customers.toLocaleString('en-IN') : '…'} loading={overview.isLoading} />
        <StatCard label="Bookings (30 days)" value={o ? o.appointmentsLast30Days.toLocaleString('en-IN') : '…'} loading={overview.isLoading} />
      </div>
      <Card padded={false}>
        <div className="border-b border-line p-4"><SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search by salon name, code or email" className="w-full sm:w-80" aria-label="Search salons" /></div>
        <DataTable columns={columns} rows={q.data?.rows} loading={q.isLoading} error={q.isError ? q.error : undefined} onRetry={() => void q.refetch()} rowKey={(r) => r.id} onRowClick={(r) => setOpenId(r.id)} pagination={{ page, pageSize: 25, total: q.data?.meta.total ?? 0, onPageChange: setPage }} empty={<EmptyState title="No salons found" description="Add the first salon to get started." action={<Button onClick={() => setCreating(true)}>Add a salon</Button>} />} />
      </Card>
      {creating && <CreateOrg onClose={() => setCreating(false)} />}
      {openId && <OrgDrawer id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function CreateOrg({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const [v, setV] = useState({ name: '', code: '', email: '', phone: '', timezone: 'Asia/Kolkata', plan: 'trial', ownerName: '', ownerEmail: '', ownerPhone: '', ownerPassword: '', branchName: '', branchCode: '', branchCity: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<typeof v>) => { setV((x) => ({ ...x, ...p })); setErrors({}); setError(null); };
  const save = useMutation({
    mutationFn: () => {
      const parsed = createOrganizationSchema.safeParse({ name: v.name, code: v.code, email: v.email, phone: v.phone, timezone: v.timezone, subscriptionPlan: v.plan, owner: { fullName: v.ownerName, email: v.ownerEmail, phone: v.ownerPhone, password: v.ownerPassword }, firstBranch: { name: v.branchName || v.name, code: v.branchCode, city: v.branchCity } });
      if (!parsed.success) {
        const errs: Record<string, string> = {};
        const map: Record<string, string> = { 'owner.fullName': 'ownerName', 'owner.email': 'ownerEmail', 'owner.phone': 'ownerPhone', 'owner.password': 'ownerPassword', 'firstBranch.name': 'branchName', 'firstBranch.code': 'branchCode', subscriptionPlan: 'plan' };
        for (const i of parsed.error.issues) { const k = i.path.join('.'); errs[map[k] ?? k] ??= i.message; }
        setErrors(errs);
        throw new Error('Please fix the highlighted fields.');
      }
      return api.post('/platform/organizations', parsed.data);
    },
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['platform'] }); toast.success('Salon created. The owner can sign in now and will be asked to choose a new password.'); onClose(); },
    onError: (e) => { if (e instanceof ApiError) setErrors((x) => ({ ...x, ...Object.fromEntries(Object.entries(e.fieldErrors).map(([k, m]) => [k, m])) })); setError(e instanceof Error && !(e instanceof ApiError) ? e.message : friendlyError(e).message); },
  });
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title="Add a salon" description="Creates the salon, its owner login and the first branch." size="lg" persistent footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate()}>Create salon</Button></>}>
      <div className="space-y-5">
        <FormError message={error} />
        <section className="grid gap-4 sm:grid-cols-2" aria-label="Salon">
          <h3 className="text-sm font-semibold sm:col-span-2">Salon</h3>
          <Field label="Salon name" required error={errors.name}><Input autoFocus value={v.name} onChange={(e) => set({ name: e.target.value, code: v.code || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) })} /></Field>
          <Field label="Web code" required error={errors.code} hint="Used in the online booking address."><Input value={v.code} onChange={(e) => set({ code: e.target.value.toLowerCase() })} /></Field>
          <Field label="Email" optional error={errors.email}><Input type="email" value={v.email} onChange={(e) => set({ email: e.target.value })} /></Field>
          <Field label="Phone" optional error={errors.phone}><Input type="tel" value={v.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
          <Field label="Time zone"><Select value={v.timezone} onChange={(e) => set({ timezone: e.target.value })}>{withCurrent(v.timezone).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</Select></Field>
          <Field label="Plan"><Select value={v.plan} onChange={(e) => set({ plan: e.target.value })}>{PLANS.map((p) => <option key={p} value={p} className="capitalize">{p}</option>)}</Select></Field>
        </section>
        <section className="grid gap-4 sm:grid-cols-2" aria-label="Owner login">
          <h3 className="text-sm font-semibold sm:col-span-2">Owner login</h3>
          <Field label="Owner’s full name" required error={errors.ownerName}><Input value={v.ownerName} onChange={(e) => set({ ownerName: e.target.value })} /></Field>
          <Field label="Owner’s email" required error={errors.ownerEmail}><Input type="email" value={v.ownerEmail} onChange={(e) => set({ ownerEmail: e.target.value })} /></Field>
          <Field label="Owner’s mobile" optional error={errors.ownerPhone}><Input type="tel" value={v.ownerPhone} onChange={(e) => set({ ownerPhone: e.target.value })} /></Field>
          <Field label="Temporary password" required error={errors.ownerPassword} hint="At least 10 characters with a letter and a number."><Input autoComplete="off" value={v.ownerPassword} onChange={(e) => set({ ownerPassword: e.target.value })} /></Field>
        </section>
        <section className="grid gap-4 sm:grid-cols-3" aria-label="First branch">
          <h3 className="text-sm font-semibold sm:col-span-3">First branch</h3>
          <Field label="Branch name" error={errors.branchName} hint="Defaults to the salon name."><Input value={v.branchName} onChange={(e) => set({ branchName: e.target.value })} /></Field>
          <Field label="Branch code" required error={errors.branchCode} hint="2–10 letters or numbers."><Input className="uppercase" value={v.branchCode} onChange={(e) => set({ branchCode: e.target.value.toUpperCase() })} /></Field>
          <Field label="City" optional><Input value={v.branchCity} onChange={(e) => set({ branchCity: e.target.value })} /></Field>
        </section>
      </div>
    </Drawer>
  );
}

function OrgDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['platform', 'org', id], queryFn: () => api.get<OrgDetail>(`/platform/organizations/${id}`) });
  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/platform/organizations/${id}`, body),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['platform'] }); toast.success('Saved'); },
    onError: (e) => toast.error(friendlyError(e).message),
  });
  const d = q.data;
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={d?.name ?? 'Salon'} description={d ? `${d.code} · created ${fmtDateTime(d.createdAt, 'Asia/Kolkata')}` : undefined} size="md">
      {q.isLoading && <Skeleton className="h-64" />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} compact />}
      {d && (
        <div className="space-y-5">
          {d.status === 'suspended' && <InlineNotice tone="danger" title="This salon is suspended">Nobody from this salon can sign in until it is reactivated.</InlineNotice>}
          <Switch checked={d.status === 'active'} onCheckedChange={(on) => update.mutate({ status: on ? 'active' : 'suspended' })} label="Salon is active" description="Switch off to suspend: all logins are blocked, data is kept." />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Plan"><Select value={d.subscriptionPlan} onChange={(e) => update.mutate({ subscriptionPlan: e.target.value })}>{PLANS.map((p) => <option key={p} value={p}>{p}</option>)}</Select></Field>
            <Field label="Billing status"><Select value={d.subscriptionStatus} onChange={(e) => update.mutate({ subscriptionStatus: e.target.value })}>{SUB.map((p) => <option key={p} value={p}>{SUB_LABEL[p]}</option>)}</Select></Field>
            <Field label="Branch limit" hint="Empty means unlimited."><Input type="number" min={1} defaultValue={d.maxBranches ?? ''} onBlur={(e) => { const next = e.target.value === '' ? null : Number(e.target.value); if (next !== d.maxBranches) update.mutate({ maxBranches: next }); }} /></Field>
          </div>
          <section><h3 className="mb-2 text-sm font-semibold">Owners</h3><ul className="divide-y divide-line text-sm">{d.owners.map((u) => <li key={u.id} className="py-2"><p className="font-medium">{u.fullName}</p><p className="text-muted">{u.email ?? u.phone} · {u.lastLoginAt ? `last signed in ${fmtDateTime(u.lastLoginAt, 'Asia/Kolkata')}` : 'never signed in'}</p></li>)}</ul></section>
          <section><h3 className="mb-2 text-sm font-semibold">Branches</h3><ul className="divide-y divide-line text-sm">{d.branches.map((b) => <li key={b.id} className="flex justify-between py-2"><span>{b.name}{b.city ? `, ${b.city}` : ''}</span><Badge>{b.code}</Badge></li>)}</ul></section>
        </div>
      )}
    </Drawer>
  );
}
