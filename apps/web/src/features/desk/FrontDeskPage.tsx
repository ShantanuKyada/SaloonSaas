import type { AppointmentDto, SalonNow } from '@salon/shared';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, CalendarPlus, DoorOpen, Receipt, Search, UserPlus, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Money, StatusBadge } from '@/components/common/badges';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardHeader, EmptyState, ErrorState, PageHeader } from '@/components/ui/display';
import { AppointmentDrawer } from '@/features/appointments/AppointmentDrawer';
import { nextActions, useAppointmentActions } from '@/features/appointments/actions';
import { SalonNowTiles, StaffNowList } from '@/features/dashboards/LiveStatus';
import { useQuickActions } from '@/features/quick/QuickActions';
import { api } from '@/lib/api';
import { useCan, useUser } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { fmtTime, greeting, todayIn } from '@/lib/format';
import { useNow } from '@/lib/hooks';

type Live = SalonNow & { branchId: string; branchName: string };

/** The receptionist's home: everything needed during a busy day on one screen, with the next click already offered. */
export function Component() {
  const user = useUser();
  const can = useCan();
  const quick = useQuickActions();
  const { branchId, branch, timezone } = useBranch();
  const actions = useAppointmentActions(timezone);
  const now = useNow(30_000);
  const [openId, setOpenId] = useState<string | null>(null);
  const today = todayIn(timezone);

  const live = useQuery({ queryKey: ['dashboard', 'now', branchId], queryFn: () => api.get<Live>('/dashboard/now', { branchId }), refetchInterval: 20_000, enabled: !!branchId });
  const todayList = useQuery({ queryKey: ['appointments', 'desk', branchId, today], queryFn: () => api.list<AppointmentDto>('/appointments', { branchId, from: today, to: today, pageSize: 100, sortDir: 'asc' }), refetchInterval: 20_000, enabled: !!branchId });

  const all = todayList.data?.rows ?? [];
  const waiting = all.filter((a) => a.status === 'waiting');
  const active = all.filter((a) => ['scheduled', 'confirmed', 'checked_in', 'in_service'].includes(a.status)).sort((a, b) => (a.startAt ?? '').localeCompare(b.startAt ?? ''));
  const toBill = all.filter((a) => a.status === 'completed' && !a.invoiceId);

  const quickTiles: Array<{ label: string; icon: React.ReactNode; run: () => void; show: boolean; hotkey: string; tone: string }> = [
    { label: 'New appointment', icon: <CalendarPlus className="size-6" />, run: () => quick.newAppointment(), show: can('appointments.create'), hotkey: 'N', tone: 'bg-primary text-primary-fg' },
    { label: 'Walk-in', icon: <DoorOpen className="size-6" />, run: () => quick.walkIn(), show: can('walkins.manage'), hotkey: 'W', tone: 'bg-surface text-fg border border-line' },
    { label: 'New customer', icon: <UserPlus className="size-6" />, run: () => quick.newCustomer(), show: can('customers.create'), hotkey: '', tone: 'bg-surface text-fg border border-line' },
  ];

  return (
    <div className="space-y-5">
      <PageHeader title={`${greeting(timezone)}, ${user.fullName.split(' ')[0]}`} description={`${branch.name} · ${new Date(now).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: timezone })}`} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {quickTiles.filter((t) => t.show).map((t) => (
          <button key={t.label} type="button" onClick={t.run} className={`flex min-h-24 flex-col items-start justify-between rounded-xl p-4 text-left shadow-card transition-transform active:scale-[0.98] ${t.tone}`}>
            {t.icon}
            <span className="flex w-full items-center justify-between text-sm font-semibold">{t.label}{t.hotkey && <kbd className="hidden rounded border border-current/30 px-1.5 text-[10px] opacity-70 lg:block">{t.hotkey}</kbd>}</span>
          </button>
        ))}
        {can('billing.create') && <QuickLink to="/billing/new" icon={<Receipt className="size-6" />} label="Create bill" hotkey="B" />}
        {can('payments.collect') && <QuickLink to="/billing/collect" icon={<Wallet className="size-6" />} label="Collect payment" hotkey="P" />}
        {can('appointments.view') && <QuickLink to="/appointments/calendar" icon={<CalendarDays className="size-6" />} label="Today’s schedule" />}
        <button type="button" onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '/' }))} className="col-span-2 flex min-h-24 items-center gap-3 rounded-xl border border-dashed border-line-strong bg-surface-2 p-4 text-left text-muted md:col-span-3 xl:col-span-2">
          <Search className="size-6" aria-hidden />
          <span className="text-sm"><span className="block font-semibold text-fg">Find a customer</span>Type a name or mobile number. Press <kbd className="rounded border border-line px-1">/</kbd> anywhere.</span>
        </button>
      </div>

      {live.data && <SalonNowTiles now={live.data} />}
      {live.isError && <ErrorState error={live.error} onRetry={() => void live.refetch()} compact />}

      <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
        <div className="space-y-5">
          {toBill.length > 0 && can('billing.create') && (
            <Card className="border-warning/40 bg-warning-soft/40">
              <CardHeader title={`${toBill.length} finished ${toBill.length === 1 ? 'service' : 'services'} waiting to be billed`} description="One tap to create the bill with the services already filled in." />
              <ul className="divide-y divide-line">
                {toBill.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{a.customer.fullName}</p>
                      <p className="truncate text-sm text-muted">{a.items.map((i) => i.serviceName).join(', ')} · <Money value={a.estimatedAmount} /></p>
                    </div>
                    <Button size="sm" icon={<Receipt className="size-4" />} onClick={() => actions.bill(a)}>Create bill</Button>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card padded={false}>
            <div className="p-4 pb-0"><CardHeader title="Coming up today" description={`${active.length} ${active.length === 1 ? 'appointment' : 'appointments'} to go`} actions={<Link to="/appointments/calendar" className="text-sm font-medium text-primary hover:underline">Open calendar</Link>} /></div>
            {todayList.isLoading ? (
              <div role="status" aria-label="Loading today's appointments" className="space-y-2 p-4"><div className="skeleton h-14" /><div className="skeleton h-14" /><div className="skeleton h-14" /></div>
            ) : active.length === 0 ? (
              <EmptyState title="No appointments waiting" description="You can create a new appointment or add a walk-in customer." action={can('appointments.create') && <Button onClick={() => quick.newAppointment()}>New appointment</Button>} />
            ) : (
              <ul className="divide-y divide-line">
                {active.map((a) => {
                  const list = nextActions(a, (p) => can(p), actions);
                  const primary = list.find((x) => x.primary);
                  const late = a.startAt && a.status !== 'in_service' && a.status !== 'checked_in' && new Date(a.startAt).getTime() < now - 10 * 60_000;
                  return (
                    <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <button type="button" onClick={() => setOpenId(a.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                        <span className="w-16 shrink-0 text-sm font-semibold tabular-nums">{fmtTime(a.startAt, timezone)}</span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold">{a.customer.fullName}</span>
                          <span className="block truncate text-xs text-muted">{a.items.map((i) => `${i.serviceName} · ${i.staffName ?? ''}`).join(', ')}</span>
                        </span>
                      </button>
                      {late && <Badge tone="danger">Running late</Badge>}
                      {a.customer.outstanding > 0 && <Badge tone="warning">Pending <Money value={a.customer.outstanding} /></Badge>}
                      <StatusBadge status={a.status} />
                      {primary && <Button size="sm" variant="soft" loading={actions.busy} onClick={primary.run}>{primary.label}</Button>}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {waiting.length > 0 && (
            <Card padded={false}>
              <div className="p-4 pb-0"><CardHeader title={`Waiting (${waiting.length})`} actions={<Link to="/walk-ins" className="text-sm font-medium text-primary hover:underline">Walk-in board</Link>} /></div>
              <ul className="divide-y divide-line">
                {waiting.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0"><p className="truncate font-medium"><span className="mr-1.5 text-muted">#{a.queueNumber}</span>{a.customer.fullName}</p><p className="truncate text-sm text-muted">{a.items.map((i) => i.serviceName).join(', ')}</p></div>
                    <Button size="sm" onClick={() => setOpenId(a.id)}>Open</Button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
        <div>{live.data && <StaffNowList staff={live.data.staff} />}</div>
      </div>

      {openId && <AppointmentDrawer id={openId} onClose={() => setOpenId(null)} />}
      {actions.dialogs}
    </div>
  );
}

function QuickLink({ to, icon, label, hotkey }: { to: string; icon: React.ReactNode; label: string; hotkey?: string }) {
  return (
    <Link to={to} className="flex min-h-24 flex-col items-start justify-between rounded-xl border border-line bg-surface p-4 shadow-card transition-transform active:scale-[0.98]">
      {icon}
      <span className="flex w-full items-center justify-between text-sm font-semibold text-fg">{label}{hotkey && <kbd className="hidden rounded border border-line px-1.5 text-[10px] text-muted lg:block">{hotkey}</kbd>}</span>
    </Link>
  );
}
