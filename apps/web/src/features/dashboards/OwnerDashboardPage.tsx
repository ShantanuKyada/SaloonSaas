import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarCheck, Clock, Info, UserPlus, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useMoney } from '@/components/common/badges';
import { Avatar, Badge, Card, CardHeader, EmptyState, ErrorState, PageHeader, StatCard } from '@/components/ui/display';
import { Segmented } from '@/components/ui/form';
import { Bars, TrendChart } from '@/components/ui/chart';
import { api } from '@/lib/api';
import { useBranch } from '@/lib/branch';
import { dateRangePreset, fmtDay, fmtTime, PRESET_LABELS, todayIn } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { OperationalAlert, StatValue } from '@salon/shared';

interface Owner {
  asOf: string;
  range: { from: string; to: string };
  revenue: { today: StatValue; week: StatValue; month: StatValue; range: StatValue; bills: StatValue; averageTicket: StatValue; discounts: StatValue };
  collections: { collected: StatValue; refunded: number };
  appointments: { today: { total: number; completed: number; pending: number; cancelled: number; noShow: number } };
  customers: { newCustomers: number; served: number; returning: number; totalActive: number; inactive60Days: number; highValue: { count: number; threshold: number }; repeatRatePercent: number };
  staff: { total: number; present: number; absent: number; onLeave: number; busy: number; available: number };
  outstanding: { total: number; overdue: number; customers: number };
  trend: { bucket: 'day' | 'month'; revenue: Array<{ date: string; revenue: number; bills: number }>; appointments: Array<{ date: string; booked: number; completed: number; cancelled: number; noShow: number }> };
  topServices: { byBookings: Array<{ serviceId: string; name: string; bookings: number; revenue: number; averageTicket: number }>; byRevenue: Array<{ serviceId: string; name: string; bookings: number; revenue: number; averageTicket: number }> };
  todaySchedule: Array<{ id: string; startAt: string | null; status: string; branchName: string; customerName: string; services: string; staff: string }>;
  topCustomers: Array<{ id: string; fullName: string; visits: number; lifetimeSpend: number; lastVisitAt: string | null; favoriteService: string | null; favoriteStaff: string | null }>;
  branches: Array<{ branchId: string; branchName: string; revenue: number; bills: number; averageTicket: number; appointments: number; cancelledOrMissed: number; customers: number; outstanding: number; overdue: number }>;
  alerts: OperationalAlert[];
}

type Preset = keyof typeof PRESET_LABELS;

/** "How is my salon doing?" answered at the top, detail below. Branch comparison shows the numbers side by side, not a ranking. */
export function Component() {
  const money = useMoney();
  const { scopeBranchId, timezone, canChoose, selection } = useBranch();
  const today = todayIn(timezone);
  const [preset, setPreset] = useState<Preset>('month');
  const range = dateRangePreset(preset, today);
  const q = useQuery({ queryKey: ['dashboard', 'owner', scopeBranchId, range.from, range.to], queryFn: () => api.get<Owner>('/dashboard/owner', { branchId: scopeBranchId, ...range }), refetchInterval: 60_000, placeholderData: (p) => p });
  const d = q.data;
  const xFormat = (v: string) => (d?.trend.bucket === 'month' ? new Date(`${v}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }) : fmtDay(v, timezone).replace(/^\w+, /, ''));

  return (
    <div className="space-y-5">
      <PageHeader title="How is the salon doing?" description={selection === 'all' && canChoose ? 'All branches' : undefined} actions={<Segmented label="Period" value={preset} onChange={setPreset} options={(Object.keys(PRESET_LABELS) as Preset[]).map((k) => ({ value: k, label: PRESET_LABELS[k] }))} />} />
      {q.isError && !d && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}

      {d && d.alerts.length > 0 && (
        <section aria-label="Things that need attention" className="grid gap-2 md:grid-cols-2">
          {d.alerts.slice(0, 4).map((a) => <AlertCard key={a.id} a={a} />)}
        </section>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Revenue" value={d ? money(d.revenue.range.value) : '…'} loading={!d} previous={d ? { current: d.revenue.range.value, before: d.revenue.range.previous } : undefined} hint={d ? `Today ${money(d.revenue.today.value)}` : undefined} />
        <StatCard label="Appointments today" value={d ? d.appointments.today.total : '…'} loading={!d} icon={<CalendarCheck className="size-4" />} tone="primary" hint={d ? `${d.appointments.today.completed} done · ${d.appointments.today.pending} to go` : undefined} />
        <StatCard label="Customers served" value={d ? d.customers.served : '…'} loading={!d} icon={<UserPlus className="size-4" />} hint={d ? `${d.customers.newCustomers} new · ${d.customers.returning} returning` : undefined} />
        <StatCard label="Pending payments" value={d ? money(d.outstanding.total) : '…'} loading={!d} tone={d && d.outstanding.overdue > 0 ? 'warning' : 'neutral'} icon={<Wallet className="size-4" />} hint={d && d.outstanding.overdue > 0 ? `${money(d.outstanding.overdue)} overdue` : 'None overdue'} />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Collected" value={d ? money(d.collections.collected.value) : '…'} loading={!d} previous={d ? { current: d.collections.collected.value, before: d.collections.collected.previous } : undefined} />
        <StatCard label="Average bill" value={d ? money(d.revenue.averageTicket.value) : '…'} loading={!d} previous={d ? { current: d.revenue.averageTicket.value, before: d.revenue.averageTicket.previous } : undefined} />
        <StatCard label="Team right now" value={d ? `${d.staff.available} free` : '…'} loading={!d} icon={<Clock className="size-4" />} hint={d ? `${d.staff.busy} busy · ${d.staff.absent + d.staff.onLeave} away` : undefined} />
        <StatCard label="Customers who come back" value={d ? `${d.customers.repeatRatePercent}%` : '…'} loading={!d} hint={d ? `${d.customers.inactive60Days} inactive for 60+ days` : undefined} />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card><CardHeader title="Revenue" description={`${fmtDay(range.from, timezone)} – ${fmtDay(range.to, timezone)}`} />{d ? <TrendChart data={d.trend.revenue} xKey="date" series={[{ key: 'revenue', label: 'Revenue' }]} format={(v) => money(v)} xFormat={xFormat} /> : <div className="skeleton h-60" />}</Card>
        <Card><CardHeader title="Appointments" />{d ? <Bars data={d.trend.appointments} xKey="date" series={[{ key: 'completed', label: 'Completed', color: 'var(--success)' }, { key: 'cancelled', label: 'Cancelled', color: 'var(--faint)' }, { key: 'noShow', label: 'No-shows', color: 'var(--danger)' }]} stacked xFormat={xFormat} /> : <div className="skeleton h-60" />}</Card>
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <Card padded={false} className="xl:col-span-2">
          <div className="p-4 pb-0"><CardHeader title="Today’s schedule" actions={<Link to="/appointments/calendar" className="text-sm font-medium text-primary hover:underline">Open calendar</Link>} /></div>
          {d && d.todaySchedule.length === 0 ? <EmptyState title="Nothing left today" description="No more appointments are booked for today." /> : (
            <ul className="divide-y divide-line">{d?.todaySchedule.map((s) => <li key={s.id} className="flex items-center gap-3 px-4 py-2.5 text-sm"><span className="w-16 font-semibold tabular-nums">{fmtTime(s.startAt, timezone)}</span><span className="min-w-0 flex-1"><span className="block truncate font-medium">{s.customerName}</span><span className="block truncate text-xs text-muted">{s.services} · {s.staff}</span></span><Badge>{s.branchName}</Badge></li>)}</ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Top services" description="By revenue" />
          <ul className="space-y-2.5">
            {d?.topServices.byRevenue.map((s) => (
              <li key={s.serviceId} className="text-sm"><div className="flex justify-between"><span className="font-medium">{s.name}</span><span className="tabular-nums">{money(s.revenue)}</span></div><div className="flex justify-between text-xs text-muted"><span>{s.bookings} bookings</span><span>avg {money(s.averageTicket)}</span></div></li>
            ))}
            {d && d.topServices.byRevenue.length === 0 && <p className="text-sm text-muted">No bills in this period.</p>}
          </ul>
        </Card>
      </div>

      {d && d.branches.length > 1 && (
        <Card padded={false}>
          <div className="p-4 pb-0"><CardHeader title="Branches side by side" description="All the numbers, so you can judge fairly: no single score." /></div>
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted"><th className="px-4 py-2.5 font-medium">Branch</th><th className="px-4 py-2.5 text-right font-medium">Revenue</th><th className="px-4 py-2.5 text-right font-medium">Appointments</th><th className="px-4 py-2.5 text-right font-medium">Customers</th><th className="px-4 py-2.5 text-right font-medium">Average bill</th><th className="px-4 py-2.5 text-right font-medium">Cancelled / no-show</th><th className="px-4 py-2.5 text-right font-medium">Pending</th></tr></thead>
              <tbody>{d.branches.map((b) => <tr key={b.branchId} className="border-b border-line last:border-0"><td className="px-4 py-3 font-medium">{b.branchName}</td><td className="px-4 py-3 text-right tabular-nums">{money(b.revenue)}</td><td className="px-4 py-3 text-right tabular-nums">{b.appointments}</td><td className="px-4 py-3 text-right tabular-nums">{b.customers}</td><td className="px-4 py-3 text-right tabular-nums">{money(b.averageTicket)}</td><td className="px-4 py-3 text-right tabular-nums">{b.cancelledOrMissed}</td><td className="px-4 py-3 text-right tabular-nums">{money(b.outstanding)}{b.overdue > 0 && <span className="block text-xs text-danger">{money(b.overdue)} overdue</span>}</td></tr>)}</tbody>
            </table>
          </div>
        </Card>
      )}

      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader title="Your best customers" actions={<Link to="/reports/customers-high-value" className="text-sm font-medium text-primary hover:underline">See all</Link>} />
          {d && d.topCustomers.length === 0 ? <p className="text-sm text-muted">Spending will show here once bills are created.</p> : (
            <ul className="divide-y divide-line">{d?.topCustomers.map((c) => <li key={c.id} className="flex items-center gap-3 py-2.5"><Avatar name={c.fullName} size="sm" /><Link to={`/customers/${c.id}`} className="min-w-0 flex-1 text-sm hover:underline"><span className="block truncate font-medium">{c.fullName}</span><span className="block truncate text-xs text-muted">{c.visits} visits · {c.favoriteService ?? '—'}{c.favoriteStaff ? ` with ${c.favoriteStaff}` : ''}</span></Link><span className="text-sm font-semibold tabular-nums">{money(c.lifetimeSpend)}</span></li>)}</ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Customer insights" />
          <ul className="grid grid-cols-2 gap-4 text-sm">
            <Insight label="Active customers" value={d?.customers.totalActive} />
            <Insight label="New in this period" value={d?.customers.newCustomers} />
            <Insight label="Haven’t visited in 60+ days" value={d?.customers.inactive60Days} to="/customers/segments" />
            <Insight label={`High-value (over ${d ? money(d.customers.highValue.threshold) : '…'})`} value={d?.customers.highValue.count} />
          </ul>
          <p className="mt-4 text-xs text-muted">Want to bring inactive customers back? <Link to="/customers/segments" className="font-medium text-primary hover:underline">Create a group</Link> and send them an offer.</p>
        </Card>
      </div>
    </div>
  );
}

function Insight({ label, value, to }: { label: string; value: number | undefined; to?: string }) {
  const inner = <><span className="block text-2xl font-semibold tabular-nums">{value ?? '…'}</span><span className="block text-xs text-muted">{label}</span></>;
  return <li>{to ? <Link to={to} className="block rounded-lg border border-line p-3 hover:border-primary/50">{inner}</Link> : <div className="rounded-lg border border-line p-3">{inner}</div>}</li>;
}

export function AlertCard({ a }: { a: OperationalAlert }) {
  const tone = { critical: 'border-danger/40 bg-danger-soft text-danger', warning: 'border-warning/40 bg-warning-soft text-warning', info: 'border-info/30 bg-info-soft text-info' }[a.severity];
  const Icon = a.severity === 'info' ? Info : AlertTriangle;
  const body = (
    <div className={cn('flex items-start gap-3 rounded-xl border p-3', tone)}>
      <Icon className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div className="min-w-0 text-fg"><p className="text-sm font-semibold">{a.title}</p><p className="text-xs opacity-80">{a.detail}</p></div>
    </div>
  );
  return a.link ? <Link to={a.link} className="block">{body}</Link> : body;
}
