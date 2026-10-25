import { GENDER_LABELS, GENDERS, type SegmentFilterInput } from '@salon/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Megaphone, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { toastError } from '@/app/providers';
import { useMoney } from '@/components/common/badges';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, ErrorState, InlineNotice, PageHeader, Skeleton } from '@/components/ui/display';
import { Field, Input, MoneyInput, Select, Switch } from '@/components/ui/form';
import { Drawer, useConfirm } from '@/components/ui/overlay';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { relativeDays } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { useServices, useStaffList } from '@/lib/queries';

interface Segment {
  id: string;
  name: string;
  description: string | null;
  filter: SegmentFilterInput;
  customerCount: number;
}
interface Preview {
  count: number;
  sample: Array<{ id: string; fullName: string; mobile: string | null; lastVisitAt: string | null; lifetimeSpend: number; visitCount: number }>;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const PRESETS: Array<{ label: string; name: string; filter: SegmentFilterInput }> = [
  { label: 'Haven’t visited in 60 days', name: 'Inactive for 60 days', filter: { inactiveForDays: 60, marketingConsentOnly: true } },
  { label: 'Top spenders (₹20,000+)', name: 'Top spenders', filter: { minLifetimeSpend: 2_000_000, marketingConsentOnly: true } },
  { label: 'Birthday this month', name: 'Birthdays this month', filter: { birthdayMonth: new Date().getMonth() + 1, marketingConsentOnly: true } },
  { label: 'Have a pending payment', name: 'Pending payments', filter: { minOutstanding: 100, marketingConsentOnly: false } },
  { label: 'Visited only once', name: 'Single-visit customers', filter: { minVisits: 1, maxVisits: 1, marketingConsentOnly: true } },
];

export function Component() {
  const can = useCan();
  const money = useMoney();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const client = useQueryClient();
  const [builder, setBuilder] = useState<{ name: string; filter: SegmentFilterInput } | null>(null);
  const list = useQuery({ queryKey: ['segments'], queryFn: () => api.get<Segment[]>('/segments') });
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/segments/${id}`), onSuccess: () => { void client.invalidateQueries({ queryKey: ['segments'] }); toast.success('Group deleted'); }, onError: toastError });

  const describe = (f: SegmentFilterInput): string[] => {
    const out: string[] = [];
    if (f.inactiveForDays) out.push(`No visit for ${f.inactiveForDays}+ days`);
    if (f.visitedWithinDays) out.push(`Visited in the last ${f.visitedWithinDays} days`);
    if (f.minLifetimeSpend) out.push(`Spent ${money(f.minLifetimeSpend)}+`);
    if (f.maxLifetimeSpend) out.push(`Spent up to ${money(f.maxLifetimeSpend)}`);
    if (f.minVisits) out.push(`${f.minVisits}+ visits`);
    if (f.maxVisits) out.push(`up to ${f.maxVisits} visits`);
    if (f.minOutstanding) out.push(`Owes ${money(f.minOutstanding)}+`);
    if (f.birthdayMonth) out.push(`Birthday in ${MONTHS[f.birthdayMonth - 1]}`);
    if (f.gender) out.push(GENDER_LABELS[f.gender]);
    if (f.tag) out.push(`Tag: ${f.tag}`);
    if (f.marketingConsentOnly) out.push('Agreed to offers');
    return out;
  };

  return (
    <div>
      <PageHeader title="Customer groups" description="Find the customers you want to reach: for example, everyone who has not visited in 60 days." actions={can('campaigns.manage') && <Button icon={<Plus className="size-4" />} onClick={() => setBuilder({ name: '', filter: { marketingConsentOnly: true } })}>New group</Button>} />
      {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
      {list.isLoading && <Skeleton className="h-40" />}
      {list.data && list.data.length === 0 && (
        <Card>
          <EmptyState title="No groups yet" description="Start from one of these ideas, then adjust it." action={<div className="flex flex-wrap justify-center gap-2">{PRESETS.map((p) => <Button key={p.label} size="sm" variant="soft" onClick={() => setBuilder({ name: p.name, filter: p.filter })}>{p.label}</Button>)}</div>} />
        </Card>
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {list.data?.map((s) => (
          <Card key={s.id}>
            <div className="flex items-start justify-between gap-2">
              <div><h2 className="font-semibold">{s.name}</h2>{s.description && <p className="text-sm text-muted">{s.description}</p>}</div>
              <Badge tone="primary">{s.customerCount} customers</Badge>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">{describe(s.filter).map((d) => <Badge key={d}>{d}</Badge>)}</div>
            <div className="mt-4 flex gap-2">
              {can('campaigns.manage') && <Button size="sm" icon={<Megaphone className="size-4" />} onClick={() => navigate(`/notifications/campaigns?segment=${s.id}`)}>Send a message</Button>}
              {can('campaigns.manage') && <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={async () => { if (await confirm({ title: `Delete “${s.name}”?`, body: 'The group is removed. The customers in it are not affected.', confirmLabel: 'Delete group', cancelLabel: 'Keep group', tone: 'danger' })) remove.mutate(s.id); }}>Delete</Button>}
            </div>
          </Card>
        ))}
      </div>
      {list.data && list.data.length > 0 && can('campaigns.manage') && (
        <div className="mt-6"><p className="mb-2 text-sm font-medium text-muted">Quick ideas</p><div className="flex flex-wrap gap-2">{PRESETS.map((p) => <Button key={p.label} size="sm" variant="outline" onClick={() => setBuilder({ name: p.name, filter: p.filter })}>{p.label}</Button>)}</div></div>
      )}
      {builder && <Builder initial={builder} onClose={() => setBuilder(null)} />}
    </div>
  );
}

function Builder({ initial, onClose }: { initial: { name: string; filter: SegmentFilterInput }; onClose: () => void }) {
  const client = useQueryClient();
  const [name, setName] = useState(initial.name);
  const [f, setF] = useState<SegmentFilterInput>(initial.filter);
  const services = useServices(undefined);
  const staff = useStaffList(undefined);
  const debounced = useDebounced(f, 350);
  const clean = Object.fromEntries(Object.entries(debounced).filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== false)) as SegmentFilterInput;
  const preview = useQuery({ queryKey: ['segments', 'preview', clean], queryFn: () => api.post<Preview>('/segments/preview', { ...clean, marketingConsentOnly: !!clean.marketingConsentOnly }), placeholderData: (p) => p });
  const save = useMutation({
    mutationFn: () => api.post('/segments', { name, filter: { ...f, marketingConsentOnly: !!f.marketingConsentOnly } }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['segments'] }); toast.success('Group saved'); onClose(); },
    onError: toastError,
  });
  const set = <K extends keyof SegmentFilterInput>(key: K, value: SegmentFilterInput[K]) => setF((cur) => ({ ...cur, [key]: value }));
  const num = (v: string) => (v === '' ? null : Number(v));
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title="Customer group" description="Describe who should be in this group. The count updates as you go." size="lg" persistent footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={name.trim().length < 2} loading={save.isPending} onClick={() => save.mutate()}>Save group</Button></>}>
      <div className="space-y-5">
        <Field label="Group name" required><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Haven’t visited in 60 days" autoFocus /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="No visit for at least (days)" optional><Input type="number" min={1} value={f.inactiveForDays ?? ''} onChange={(e) => set('inactiveForDays', num(e.target.value))} /></Field>
          <Field label="Visited within the last (days)" optional><Input type="number" min={1} value={f.visitedWithinDays ?? ''} onChange={(e) => set('visitedWithinDays', num(e.target.value))} /></Field>
          <Field label="Spent at least" optional><MoneyInput value={f.minLifetimeSpend ?? null} onChange={(v) => set('minLifetimeSpend', v)} /></Field>
          <Field label="Spent at most" optional><MoneyInput value={f.maxLifetimeSpend ?? null} onChange={(v) => set('maxLifetimeSpend', v)} /></Field>
          <Field label="At least this many visits" optional><Input type="number" min={0} value={f.minVisits ?? ''} onChange={(e) => set('minVisits', num(e.target.value))} /></Field>
          <Field label="At most this many visits" optional><Input type="number" min={0} value={f.maxVisits ?? ''} onChange={(e) => set('maxVisits', num(e.target.value))} /></Field>
          <Field label="Owes at least" optional><MoneyInput value={f.minOutstanding ?? null} onChange={(v) => set('minOutstanding', v)} /></Field>
          <Field label="Birthday month" optional><Select value={f.birthdayMonth ?? ''} onChange={(e) => set('birthdayMonth', num(e.target.value))}><option value="">Any</option>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</Select></Field>
          <Field label="Favourite service" optional><Select value={f.favoriteServiceId ?? ''} onChange={(e) => set('favoriteServiceId', e.target.value || null)}><option value="">Any</option>{(services.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          <Field label="Favourite team member" optional><Select value={f.favoriteStaffId ?? ''} onChange={(e) => set('favoriteStaffId', e.target.value || null)}><option value="">Any</option>{(staff.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.displayName}</option>)}</Select></Field>
          <Field label="Gender" optional><Select value={f.gender ?? ''} onChange={(e) => set('gender', (e.target.value || null) as SegmentFilterInput['gender'])}><option value="">Any</option>{GENDERS.map((g) => <option key={g} value={g}>{GENDER_LABELS[g]}</option>)}</Select></Field>
          <Field label="Tag" optional><Input value={f.tag ?? ''} onChange={(e) => set('tag', e.target.value || null)} placeholder="e.g. VIP" /></Field>
        </div>
        <Switch checked={!!f.marketingConsentOnly} onCheckedChange={(v) => set('marketingConsentOnly', v)} label="Only customers who agreed to offers" description="Required for promotional messages. Switch off only to look at the whole group, for example to follow up on pending payments." />
        <div className="rounded-xl border border-line bg-surface-2 p-4" aria-live="polite">
          <p className={`text-sm font-semibold ${preview.isError ? 'text-danger' : ''}`}>{preview.isError ? 'We could not count customers. Please check the numbers you entered.' : preview.data ? `${preview.data.count} ${preview.data.count === 1 ? 'customer matches' : 'customers match'}` : 'Counting…'}</p>
          {!preview.isError && preview.data && preview.data.sample.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm">{preview.data.sample.slice(0, 5).map((c) => <li key={c.id} className="flex justify-between gap-3"><span>{c.fullName}</span><span className="text-muted">last visit {relativeDays(c.lastVisitAt)} · {c.visitCount} visits</span></li>)}</ul>
          )}
          {!preview.isError && preview.data && preview.data.count > 5 && <p className="mt-1 text-xs text-muted">…and {preview.data.count - 5} more</p>}
        </div>
        {!f.marketingConsentOnly && <InlineNotice tone="info">This group includes customers who have not agreed to promotional messages. Campaigns only ever reach those who have.</InlineNotice>}
      </div>
    </Drawer>
  );
}
