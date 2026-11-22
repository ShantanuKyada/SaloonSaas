import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, ChevronRight, Info } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useCompactMoney, useMoney } from '@/components/common/badges';
import { Avatar, Badge, Card, CardHeader, ErrorState, PageHeader, StatCard } from '@/components/ui/display';
import { Segmented } from '@/components/ui/form';
import { Bars, TrendChart } from '@/components/ui/chart';
import { ChartCard, Meter, RankedBars, SplitBar, StorySection } from '@/components/ui/viz';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { dateRangePreset, deltaPercent, fmtDay, fmtTime, pct, PRESET_LABELS, todayIn } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { OperationalAlert, SalonNow, StatValue } from '@salon/shared';
import { SalonNowTiles, StaffNowList } from './LiveStatus';

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

interface StaffMetric { staffId: string; staffName: string; branchName: string; completedAppointments: number; revenue: number; servicesPerformed: number; customers: number; bookedMinutes: number; availableMinutes: number; utilizationPercent: number }

export function Component() {
  return <BusinessDashboard variant="owner" />;
}

/**
 * "How is the salon doing?" told as a story, top to bottom: what needs attention, the money (one headline number and
 * its trend), today, what is booked and what sells, the team, the customers, and the branches side by side. Every
 * figure opens the page or report behind it for the same period, and the period filter above scopes everything.
 * The branch manager's "Today" page is the same story for their branch, with the salon right now (who is serving,
 * who is waiting, each team member's status) updating live in the Today section.
 */
export function BusinessDashboard({ variant }: { variant: 'owner' | 'branch' }) {
  const money = useMoney();
  const compact = useCompactMoney();
  const can = useCan();
  const { scopeBranchId, timezone, canChoose, selection, branch } = useBranch();
  const today = todayIn(timezone);
  const [preset, setPreset] = useState<Preset>('month');
  const range = dateRangePreset(preset, today);
  const q = useQuery({ queryKey: ['dashboard', 'owner', scopeBranchId, range.from, range.to], queryFn: () => api.get<Owner>('/dashboard/owner', { branchId: scopeBranchId, ...range }), refetchInterval: 60_000, placeholderData: (p) => p });
  const d = q.data;
  const live = useQuery({ queryKey: ['dashboard', 'now', scopeBranchId], queryFn: () => api.get<SalonNow>('/dashboard/now', { branchId: scopeBranchId }), refetchInterval: 20_000, enabled: variant === 'branch' && !!scopeBranchId });
  const team = useQuery({ queryKey: ['analytics', 'staff', scopeBranchId, range.from, range.to], queryFn: () => api.get<{ staff: StaffMetric[] }>('/analytics/staff', { branchId: scopeBranchId, ...range }), enabled: can('staff.performance'), placeholderData: (p) => p });
  const staff = [...(team.data?.staff ?? [])].sort((a, b) => b.revenue - a.revenue);
  const oneBranch = variant === 'branch' && !!scopeBranchId;
  // A new period keeps the previous numbers on screen, dimmed, until the new ones arrive: no flash, no jump.
  const refreshing = q.isFetching && q.isPlaceholderData;
  const xFormat = (v: string) => (d?.trend.bucket === 'month' ? new Date(`${v}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }) : fmtDay(v, timezone).replace(/^\w+, /, ''));
  const report = (key: string) => `/reports/${key}?from=${range.from}&to=${range.to}${scopeBranchId ? `&branchId=${scopeBranchId}` : ''}`;
  const period = `${fmtDay(range.from, timezone)} – ${fmtDay(range.to, timezone)}`;

  return (
    <div className="space-y-8">
      <PageHeader title={oneBranch ? `How is ${branch.name} doing?` : 'How is the salon doing?'} description={`${PRESET_LABELS[preset]} · ${period}${selection === 'all' && canChoose ? ' · All branches' : ''}`} actions={<Segmented label="Period" value={preset} onChange={setPreset} options={(Object.keys(PRESET_LABELS) as Preset[]).map((k) => ({ value: k, label: PRESET_LABELS[k] }))} />} />
      {q.isError && !d && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}

      <div className={cn('space-y-8 transition-opacity', refreshing && 'opacity-60')} aria-busy={refreshing || !d}>
        {d && d.alerts.length > 0 && (
          <section aria-labelledby="attention" className="space-y-3">
            <h2 id="attention" className="text-xs font-semibold uppercase tracking-wide text-muted">Needs attention</h2>
            <div className="grid gap-2 md:grid-cols-2">{d.alerts.slice(0, 4).map((a) => <AlertCard key={a.id} a={a} />)}</div>
          </section>
        )}

        {/* ── Money ─────────────────────────────────────────────── */}
        <StorySection id="money" title="Money" story={d && moneyStory(d, money)}>
          <div className="grid gap-4 lg:grid-cols-3">
            <ChartCard
              className="lg:col-span-2"
              title="Revenue"
              heading={
                <div className="min-w-0">
                  <p className="text-sm font-medium text-muted">Revenue · {PRESET_LABELS[preset].toLowerCase()}</p>
                  {d ? <p className="mt-1 text-5xl font-semibold tracking-tight text-fg max-sm:text-4xl">{money(d.revenue.range.value)}</p> : <div className="skeleton mt-2 h-12 w-56" />}
                  {d && (
                    <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
                      <Change value={d.revenue.range.value} before={d.revenue.range.previous} />
                      <span>Today {money(d.revenue.today.value)}</span>
                      <span>Discounts given {money(d.revenue.discounts.value)}</span>
                      <Link to={report('revenue-daily')} className="font-medium text-primary hover:underline">Revenue report</Link>
                    </p>
                  )}
                </div>
              }
              chart={d ? <TrendChart data={d.trend.revenue} xKey="date" series={[{ key: 'revenue', label: 'Revenue' }]} format={(v) => money(v)} axisFormat={compact} xFormat={xFormat} height={220} /> : <div className="skeleton h-[220px]" />}
              table={{ columns: ['Date', 'Revenue', 'Bills'], rows: (d?.trend.revenue ?? []).map((r) => [xFormat(r.date), money(r.revenue), r.bills]) }}
            />
            <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
              <StatCard label="Collected" to="/billing/payments" value={d ? money(d.collections.collected.value) : '…'} loading={!d} previous={d ? { current: d.collections.collected.value, before: d.collections.collected.previous } : undefined} hint={d && d.collections.refunded > 0 ? `${money(d.collections.refunded)} refunded` : undefined} />
              <StatCard label="Average bill" to="/billing/bills" value={d ? money(d.revenue.averageTicket.value) : '…'} loading={!d} previous={d ? { current: d.revenue.averageTicket.value, before: d.revenue.averageTicket.previous } : undefined} hint={d ? `${d.revenue.bills.value} bills` : undefined} />
              <StatCard
                label="Pending payments"
                to="/billing/pending"
                tone={d && d.outstanding.total > 0 ? 'danger' : 'success'}
                emphasized={!!d}
                value={d ? (d.outstanding.total > 0 ? money(d.outstanding.total) : 'All paid') : '…'}
                loading={!d}
                hint={d && (d.outstanding.total > 0 ? `${d.outstanding.customers} ${d.outstanding.customers === 1 ? 'customer' : 'customers'}${d.outstanding.overdue > 0 ? ` · ${money(d.outstanding.overdue)} overdue` : ''}` : 'Nothing to collect')}
              />
            </div>
          </div>
        </StorySection>

        {/* ── Today ─────────────────────────────────────────────── */}
        <StorySection id="today" title="Today" story={d && todayStory(d)}>
          {oneBranch && live.data && <div className="mb-4"><SalonNowTiles now={live.data} /></div>}
          <div className="grid gap-4 lg:grid-cols-3">
            <LinkCard to="/appointments?range=today" title="Appointments today" action="Open today’s appointments">
              <p className="text-3xl font-semibold tracking-tight text-fg">{d?.appointments.today.total ?? '…'}</p>
              {d && (
                <div className="mt-3">
                  <SplitBar label="Today’s appointments" parts={[
                    { key: 'done', label: 'Done', value: d.appointments.today.completed, color: 'var(--chart-good)' },
                    { key: 'pending', label: 'To go', value: d.appointments.today.pending, color: 'var(--chart-accent)' },
                    { key: 'cancelled', label: 'Cancelled', value: d.appointments.today.cancelled, color: 'var(--chart-muted)' },
                    { key: 'noShow', label: 'No-show', value: d.appointments.today.noShow, color: 'var(--chart-critical)' },
                  ]} />
                </div>
              )}
            </LinkCard>
            {oneBranch && live.data ? <StaffNowList staff={live.data.staff} /> : <LinkCard to="/staff/attendance" title="Team right now" action="Open attendance">
              <p className="text-3xl font-semibold tracking-tight text-fg">{d ? `${d.staff.available} free` : '…'}</p>
              {d && (
                <div className="mt-3">
                  <SplitBar label="Team right now" parts={[
                    { key: 'busy', label: 'Busy', value: d.staff.busy, color: 'var(--chart-accent)' },
                    { key: 'free', label: 'Free', value: d.staff.available, color: 'var(--chart-good)' },
                    { key: 'away', label: 'Away', value: d.staff.absent + d.staff.onLeave, color: 'var(--chart-muted)' },
                  ]} />
                  <p className="mt-2 text-xs text-muted">{d.staff.present} of {d.staff.total} came in today</p>
                </div>
              )}
            </LinkCard>}
            <Card padded={false}>
              <div className="flex items-center justify-between gap-2 p-4 pb-2">
                <h3 className="text-base font-semibold">Coming up</h3>
                <Link to="/appointments/calendar" className="text-sm font-medium text-primary hover:underline">Calendar</Link>
              </div>
              {d && d.todaySchedule.length === 0 ? <p className="px-4 pb-4 text-sm text-muted">Nothing more is booked for today.</p> : (
                <ul className="scroll-thin max-h-56 divide-y divide-line overflow-y-auto">
                  {d?.todaySchedule.map((s) => (
                    <li key={s.id}>
                      <Link to={`/appointments/${s.id}`} className="flex items-center gap-3 px-4 py-2 text-sm hover:bg-surface-2">
                        <span className="w-16 shrink-0 font-semibold tabular-nums">{fmtTime(s.startAt, timezone)}</span>
                        <span className="min-w-0 flex-1"><span className="block truncate font-medium">{s.customerName}</span><span className="block truncate text-xs text-muted">{s.services} · {s.staff}</span></span>
                        {selection === 'all' && canChoose && <Badge>{s.branchName}</Badge>}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </StorySection>

        {/* ── Bookings and services ─────────────────────────────── */}
        <StorySection id="bookings" title="Bookings and services" story={d && bookingsStory(d, money)}>
          <div className="grid gap-4 xl:grid-cols-5">
            <ChartCard
              className="xl:col-span-3"
              title="Appointments"
              description="How bookings ended, by day"
              link={{ to: report('appointments-daily'), label: 'Report' }}
              chart={d ? <Bars data={d.trend.appointments} xKey="date" stacked xFormat={xFormat} height={240} series={[{ key: 'completed', label: 'Completed', color: 'var(--chart-good)' }, { key: 'cancelled', label: 'Cancelled', color: 'var(--chart-muted)' }, { key: 'noShow', label: 'No-show', color: 'var(--chart-critical)' }]} /> : <div className="skeleton h-60" />}
              table={{ columns: ['Date', 'Booked', 'Completed', 'Cancelled', 'No-show'], rows: (d?.trend.appointments ?? []).map((r) => [xFormat(r.date), r.booked, r.completed, r.cancelled, r.noShow]) }}
            />
            <Card className="xl:col-span-2">
              <CardHeader title="Top services" description="By revenue in this period" actions={<Link to={report('revenue-services')} className="text-sm font-medium text-primary hover:underline">Report</Link>} />
              {d ? <RankedBars format={(v) => money(v)} empty="No bills in this period." rows={d.topServices.byRevenue.map((s) => ({ key: s.serviceId, label: s.name, value: s.revenue, note: `${s.bookings} ${s.bookings === 1 ? 'booking' : 'bookings'} · average ${money(s.averageTicket)}` }))} /> : <div className="skeleton h-48" />}
            </Card>
          </div>
        </StorySection>

        {/* ── Team ──────────────────────────────────────────────── */}
        {can('staff.performance') && (
          <StorySection id="team" title="Team" story={team.data && teamStory(staff, money)}>
            <div className="grid gap-4 xl:grid-cols-5">
              <Card className="xl:col-span-3">
                <CardHeader title="Revenue by team member" description="Services they performed in this period" actions={<Link to={report('staff-revenue')} className="text-sm font-medium text-primary hover:underline">Report</Link>} />
                {team.data ? <RankedBars format={(v) => money(v)} empty="No services billed in this period." rows={staff.filter((m) => m.revenue > 0).slice(0, 8).map((m) => ({ key: m.staffId, label: m.staffName, value: m.revenue, to: `/staff/${m.staffId}`, note: `${m.completedAppointments} ${m.completedAppointments === 1 ? 'appointment' : 'appointments'} · ${m.customers} ${m.customers === 1 ? 'customer' : 'customers'}${selection === 'all' && canChoose ? ` · ${m.branchName}` : ''}` }))} /> : <div className="skeleton h-48" />}
              </Card>
              <Card className="xl:col-span-2">
                <CardHeader title="How busy each person was" description="Booked time out of their working hours" actions={<Link to={report('staff-utilization')} className="text-sm font-medium text-primary hover:underline">Report</Link>} />
                {team.data ? (
                  staff.length === 0 ? <p className="text-sm text-muted">No team members in this branch yet.</p> : (
                    <ul className="space-y-3">
                      {[...staff].sort((a, b) => b.utilizationPercent - a.utilizationPercent).slice(0, 8).map((m) => (
                        <li key={m.staffId}>
                          <div className="mb-1 flex items-baseline justify-between gap-2 text-sm"><span className="truncate font-medium">{m.staffName}</span><span className="tabular-nums text-muted">{m.utilizationPercent}%</span></div>
                          <Meter value={m.utilizationPercent} label={`${m.staffName}: booked ${m.utilizationPercent}% of working time`} />
                        </li>
                      ))}
                    </ul>
                  )
                ) : <div className="skeleton h-48" />}
              </Card>
            </div>
          </StorySection>
        )}

        {/* ── Customers ─────────────────────────────────────────── */}
        <StorySection id="customers" title="Customers" story={d && customersStory(d)}>
          <div className="grid gap-4 lg:grid-cols-3">
            <LinkCard to={report('customers-returning')} title="Customers served" action="Returning customers report">
              <p className="text-3xl font-semibold tracking-tight text-fg">{d?.customers.served ?? '…'}</p>
              {d && (
                <div className="mt-3 space-y-4">
                  <SplitBar label="Customers served" parts={[
                    { key: 'returning', label: 'Had visited before', value: d.customers.returning, color: 'var(--chart-accent)' },
                    { key: 'first', label: 'First visit', value: Math.max(d.customers.served - d.customers.returning, 0), color: 'var(--chart-muted)' },
                  ]} />
                  <div>
                    <div className="mb-1.5 flex items-baseline justify-between text-sm"><span className="text-muted">Of {d.customers.totalActive} active customers, visited</span><span className="font-semibold text-fg">{pct(d.customers.served, d.customers.totalActive)}%</span></div>
                    <Meter value={pct(d.customers.served, d.customers.totalActive)} label="Active customers who visited in this period" />
                  </div>
                </div>
              )}
            </LinkCard>
            <div className="grid grid-cols-2 gap-4">
              <StatCard label="Active customers" to="/customers" value={d?.customers.totalActive ?? '…'} loading={!d} />
              <StatCard label="Joined this period" to={report('customers-new')} value={d?.customers.newCustomers ?? '…'} loading={!d} />
              <StatCard label="Away 60+ days" to={report('customers-inactive')} value={d?.customers.inactive60Days ?? '…'} loading={!d} tone="warning" emphasized={!!d && d.customers.inactive60Days > 0} hint="Win them back" />
              <StatCard label="High-value" to={report('customers-high-value')} value={d?.customers.highValue.count ?? '…'} loading={!d} hint={d ? `Over ${money(d.customers.highValue.threshold)}` : undefined} />
            </div>
            <Card>
              <CardHeader title="Your best customers" actions={<Link to={report('customers-high-value')} className="text-sm font-medium text-primary hover:underline">See all</Link>} />
              {d && d.topCustomers.length === 0 ? <p className="text-sm text-muted">Spending will show here once bills are created.</p> : (
                <ul className="divide-y divide-line">
                  {d?.topCustomers.slice(0, 5).map((c) => (
                    <li key={c.id}>
                      <Link to={`/customers/${c.id}`} className="flex items-center gap-3 py-2 hover:bg-surface-2">
                        <Avatar name={c.fullName} size="sm" />
                        <span className="min-w-0 flex-1 text-sm"><span className="block truncate font-medium">{c.fullName}</span><span className="block truncate text-xs text-muted">{c.visits} visits · {c.favoriteService ?? '—'}{c.favoriteStaff ? ` with ${c.favoriteStaff}` : ''}</span></span>
                        <span className="text-sm font-semibold tabular-nums">{money(c.lifetimeSpend)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </StorySection>

        {/* ── Branches ──────────────────────────────────────────── */}
        {d && d.branches.length > 1 && (
          <StorySection id="branches" title="Branches side by side" story="All the numbers for each branch, so you can judge fairly: no single score.">
            <Card padded={false}>
              <div className="flex justify-end p-3 pb-0"><Link to={report('revenue-branches')} className="text-sm font-medium text-primary hover:underline">Branch report</Link></div>
              <div className="scroll-thin overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted"><th className="px-4 py-2.5 font-medium">Branch</th><th className="px-4 py-2.5 font-medium">Revenue</th><th className="px-4 py-2.5 text-right font-medium">Appointments</th><th className="px-4 py-2.5 text-right font-medium">Customers</th><th className="px-4 py-2.5 text-right font-medium">Average bill</th><th className="px-4 py-2.5 text-right font-medium">Cancelled / no-show</th><th className="px-4 py-2.5 text-right font-medium">Pending</th></tr></thead>
                  <tbody>
                    {d.branches.map((b) => {
                      const top = Math.max(...d.branches.map((x) => x.revenue), 1);
                      return (
                        <tr key={b.branchId} className="border-b border-line last:border-0">
                          <td className="px-4 py-3 font-medium">{b.branchName}</td>
                          <td className="min-w-44 px-4 py-3"><span className="tabular-nums">{money(b.revenue)}</span><span aria-hidden className="mt-1 block h-1.5 rounded-r" style={{ width: `${Math.max((b.revenue / top) * 100, 1)}%`, background: 'var(--chart-accent)' }} /></td>
                          <td className="px-4 py-3 text-right tabular-nums">{b.appointments}</td>
                          <td className="px-4 py-3 text-right tabular-nums">{b.customers}</td>
                          <td className="px-4 py-3 text-right tabular-nums">{money(b.averageTicket)}</td>
                          <td className="px-4 py-3 text-right tabular-nums">{b.cancelledOrMissed}</td>
                          <td className={cn('px-4 py-3 text-right tabular-nums', b.outstanding > 0 && 'text-danger')}>{money(b.outstanding)}{b.overdue > 0 && <span className="block text-xs">{money(b.overdue)} overdue</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          </StorySection>
        )}
      </div>
    </div>
  );
}

// ───────────── Story lines: the one sentence each section's numbers support ─────────────
type Money = (v: number) => string;

function moneyStory(d: Owner, money: Money): ReactNode {
  const change = deltaPercent(d.revenue.range.value, d.revenue.range.previous);
  const first = change === null ? `Revenue so far is ${money(d.revenue.range.value)}` : change === 0 ? 'Revenue is level with the previous period' : `Revenue is ${change > 0 ? 'up' : 'down'} ${Math.abs(change)}% on the previous period`;
  const pending = d.outstanding.total > 0 ? `; ${money(d.outstanding.total)} is still to be collected${d.outstanding.overdue > 0 ? `, ${money(d.outstanding.overdue)} of it overdue` : ''}.` : ', and nothing is waiting to be collected.';
  return first + pending;
}

function todayStory(d: Owner): ReactNode {
  const t = d.appointments.today;
  const visits = t.total === 0 ? 'No appointments today yet' : `${t.completed} of ${t.total} appointments done, ${t.pending} to go`;
  const { present, available } = d.staff;
  const team =
    present === 0 ? 'no one from the team has come in yet'
    : present === 1 ? `the one team member in today ${available ? 'is free' : 'is not free'} right now`
    : available === 0 ? `none of the ${present} team members in today is free right now`
    : `${available} of the ${present} team members in today ${available === 1 ? 'is' : 'are'} free right now`;
  return `${visits}; ${team}.`;
}

function bookingsStory(d: Owner, money: Money): ReactNode {
  const sum = d.trend.appointments.reduce((a, r) => ({ completed: a.completed + r.completed, cancelled: a.cancelled + r.cancelled, noShow: a.noShow + r.noShow }), { completed: 0, cancelled: 0, noShow: 0 });
  const ended = sum.completed + sum.cancelled + sum.noShow;
  const top = d.topServices.byRevenue[0];
  const first = ended === 0 ? 'No finished bookings in this period yet' : `${pct(sum.completed, ended)}% of bookings were completed, with ${sum.cancelled} cancelled and ${sum.noShow} no-show${sum.noShow === 1 ? '' : 's'}`;
  return `${first}.${top ? ` ${top.name} brings in the most (${money(top.revenue)}).` : ''}`;
}

function teamStory(staff: StaffMetric[], money: Money): ReactNode {
  const earners = staff.filter((m) => m.revenue > 0);
  if (earners.length === 0) return 'Nobody has billed a service in this period yet.';
  const booked = staff.reduce((a, m) => a + m.bookedMinutes, 0);
  const available = staff.reduce((a, m) => a + m.availableMinutes, 0);
  const busy = available > 0 ? Math.round((booked / available) * 100) : null;
  return <><strong className="font-semibold text-fg">{earners[0]!.staffName}</strong> brought in the most, {money(earners[0]!.revenue)}.{busy !== null && <> The team was booked for <strong className="font-semibold text-fg">{busy}%</strong> of its working time.</>}</>;
}

function customersStory(d: Owner): ReactNode {
  const c = d.customers;
  if (c.served === 0) return `No customers billed in this period yet; ${c.newCustomers} new ${c.newCustomers === 1 ? 'customer' : 'customers'} joined.`;
  const away = c.inactive60Days > 0 ? `, and ${c.inactive60Days} haven’t visited in 60 days` : '';
  return `${c.served} customers visited and ${c.repeatRatePercent}% of them had been before; ${c.newCustomers} new ${c.newCustomers === 1 ? 'customer' : 'customers'} joined${away}.`;
}

// ───────────── Pieces ─────────────
/** "▲ 12% vs previous period", coloured by direction, with an arrow and words (never colour alone). */
function Change({ value, before }: { value: number; before: number | null }) {
  const change = deltaPercent(value, before);
  if (change === null) return null;
  const up = change >= 0;
  return (
    <span className={cn('inline-flex items-center gap-0.5 font-medium', up ? 'text-success' : 'text-danger')}>
      {up ? <ArrowUpRight className="size-4" aria-hidden /> : <ArrowDownRight className="size-4" aria-hidden />}
      {up ? 'Up' : 'Down'} {Math.abs(change)}% <span className="font-normal text-muted">vs previous period</span>
    </span>
  );
}

/** A card that is one big link to the page behind its numbers. */
function LinkCard({ to, title, action, children }: { to: string; title: string; action: string; children: ReactNode }) {
  return (
    <Link to={to} className="group flex flex-col rounded-card border border-line bg-surface p-4 shadow-card transition-colors hover:border-primary/50 focus-visible:border-primary md:p-5">
      <h3 className="text-sm font-medium text-muted">{title}</h3>
      <div className="mt-1 flex-1">{children}</div>
      <span className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary">{action}<ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden /></span>
    </Link>
  );
}

export function AlertCard({ a }: { a: OperationalAlert }) {
  const tone = { critical: 'border-danger/40 bg-danger-soft text-danger', warning: 'border-warning/40 bg-warning-soft text-warning', info: 'border-info/30 bg-info-soft text-info' }[a.severity];
  const Icon = a.severity === 'info' ? Info : AlertTriangle;
  const body = (
    <div className={cn('flex items-start gap-3 rounded-xl border p-3', tone)}>
      <Icon className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 text-fg"><p className="text-sm font-semibold">{a.title}</p><p className="text-xs opacity-80">{a.detail}</p></div>
      {a.link && <ChevronRight className="mt-0.5 size-4 shrink-0 text-faint" aria-hidden />}
    </div>
  );
  return a.link ? <Link to={a.link} className="block rounded-xl hover:opacity-90">{body}</Link> : body;
}
