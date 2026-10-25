import type { OperationalAlert, SalonNow } from '@salon/shared';
import { useQuery } from '@tanstack/react-query';
import { CalendarPlus, DoorOpen } from 'lucide-react';
import { Link } from 'react-router';
import { Money } from '@/components/common/badges';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, ErrorState, PageHeader, StatCard } from '@/components/ui/display';
import { SalonNowTiles, StaffNowList } from '@/features/dashboards/LiveStatus';
import { useQuickActions } from '@/features/quick/QuickActions';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { useMoney } from '@/components/common/badges';
import { APPOINTMENT_STATUS_LABELS, type AppointmentStatus } from '@salon/shared';
import { AlertCard } from './OwnerDashboardPage';

interface BranchDash {
  now: (SalonNow & { branchId: string; branchName: string }) | undefined;
  today: { revenue: number; bills: number; collected: number; refunded: number; outstanding: number; overdue: number; appointmentsByStatus: Record<string, number> };
  alerts: OperationalAlert[];
}

/** The manager's bird's-eye view: salon status in seconds, today's money, and what needs attention. */
export function Component() {
  const { branchId, branch } = useBranch();
  const can = useCan();
  const money = useMoney();
  const quick = useQuickActions();
  const q = useQuery({ queryKey: ['dashboard', 'branch', branchId], queryFn: () => api.get<BranchDash>('/dashboard/branch', { branchId }), refetchInterval: 20_000, enabled: !!branchId });
  const d = q.data;
  const statuses = Object.entries(d?.today.appointmentsByStatus ?? {}).filter(([, n]) => n > 0);
  return (
    <div className="space-y-5">
      <PageHeader title="Today at the salon" description={`${branch.name} · updates every few seconds`} actions={<>{can('walkins.manage') && <Button variant="outline" icon={<DoorOpen className="size-4" />} onClick={() => quick.walkIn()}>Walk-in</Button>}{can('appointments.create') && <Button icon={<CalendarPlus className="size-4" />} onClick={() => quick.newAppointment()}>New appointment</Button>}</>} />
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {d?.alerts.length ? <section aria-label="Things that need attention" className="grid gap-2 md:grid-cols-2">{d.alerts.map((a) => <AlertCard key={a.id} a={a} />)}</section> : null}
      {d?.now && <SalonNowTiles now={d.now} />}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Sales today" value={d ? money(d.today.revenue) : '…'} loading={!d} hint={d ? `${d.today.bills} bills` : undefined} />
        <StatCard label="Collected today" value={d ? money(d.today.collected) : '…'} loading={!d} hint={d && d.today.refunded > 0 ? `${money(d.today.refunded)} refunded` : undefined} />
        <StatCard label="Pending payments" value={d ? money(d.today.outstanding) : '…'} loading={!d} tone={d && d.today.overdue > 0 ? 'warning' : 'neutral'} hint={d && d.today.overdue > 0 ? `${money(d.today.overdue)} overdue` : undefined} />
        <StatCard label="Appointments" value={d ? Object.entries(d.today.appointmentsByStatus).filter(([s]) => !['cancelled', 'no_show', 'waiting'].includes(s)).reduce((a, [, n]) => a + n, 0) : '…'} loading={!d} hint={statuses.map(([s, n]) => `${n} ${APPOINTMENT_STATUS_LABELS[s as AppointmentStatus]?.toLowerCase() ?? s}`).join(' · ')} />
      </div>
      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <Card>
          <CardHeader title="Where to look next" />
          <ul className="grid gap-2 sm:grid-cols-2">
            {[['/appointments/calendar', 'Calendar and team timeline', 'See who is busy, free or away at a glance.'], ['/walk-ins', 'Walk-in board', `${d?.now?.waitingCustomers ?? 0} customers waiting.`], ['/billing/pending', 'Pending payments', d ? `${money(d.today.outstanding)} to collect.` : ''], ['/staff/attendance', 'Attendance', 'Who has come in today.']].map(([to, title, text]) => (
              <li key={to}><Link to={to!} className="block rounded-xl border border-line p-3 hover:border-primary/50"><p className="font-medium">{title}</p><p className="text-sm text-muted">{text}</p></Link></li>
            ))}
          </ul>
          {d && d.today.outstanding > 0 && <p className="mt-4 text-sm text-muted">Collect the <Money value={d.today.outstanding} className="font-semibold text-warning" /> pending on <Link to="/billing/pending" className="font-medium text-primary hover:underline">Pending payments</Link>.</p>}
        </Card>
        {d?.now && <StaffNowList staff={d.now.staff} />}
      </div>
    </div>
  );
}
