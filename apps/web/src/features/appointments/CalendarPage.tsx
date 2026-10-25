import type { AppointmentDto, CalendarData } from '@salon/shared';
import { WEEKDAY_SHORT, type AppointmentItemDto } from '@salon/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, ChevronLeft, ChevronRight, DoorOpen, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { toastError } from '@/app/providers';
import { StatusBadge } from '@/components/common/badges';
import { Button, IconButton } from '@/components/ui/button';
import { Card, EmptyState, ErrorState, PageHeader, Badge } from '@/components/ui/display';
import { Checkbox, DateInput, Segmented, Switch } from '@/components/ui/form';
import { Modal, Popover } from '@/components/ui/overlay';
import { useQuickActions } from '@/features/quick/QuickActions';
import { api } from '@/lib/api';
import { useCan, useUser } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { addDaysTo, endOfMonth, fmtDay, fmtTime, localDate, minutesOfDay, startOfMonth, startOfWeek, todayIn, toInstant, weekdayOf } from '@/lib/format';
import { cn } from '@/lib/utils';
import { AppointmentDrawer } from './AppointmentDrawer';
import { CalendarGrid, type GridColumn, type GridItem, type MoveRequest, type ResizeRequest } from './calendar/CalendarGrid';
import { useRefreshAppointments } from './actions';

type View = 'day' | 'week' | 'month';
type Group = 'staff' | 'service';

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fmtMinLabel = (m: number) => fmtTime(toInstant('2000-01-01', hhmm(m), 'UTC'), 'UTC');

export function Component() {
  const { branchId, timezone, branch } = useBranch();
  const user = useUser();
  const can = useCan();
  const quick = useQuickActions();
  const refresh = useRefreshAppointments();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const today = todayIn(timezone);
  const view = (params.get('view') as View) || 'day';
  const group = (params.get('group') as Group) || 'staff';
  const date = params.get('date') || today;
  const staffFilter = (params.get('staff') ?? '').split(',').filter(Boolean);
  const [openId, setOpenId] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<MoveRequest | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v === null || v === '' ? next.delete(k) : next.set(k, v));
    setParams(next, { replace: true });
  };

  const range = useMemo(() => {
    if (view === 'week') {
      const from = startOfWeek(date);
      return { from, to: addDaysTo(from, 6) };
    }
    if (view === 'month') return { from: startOfMonth(date), to: endOfMonth(date) };
    return { from: date, to: date };
  }, [view, date]);

  const calendar = useQuery({
    queryKey: ['calendar', branchId, range.from, range.to, staffFilter.join(',')],
    queryFn: () => api.get<CalendarData>('/appointments/calendar', { branchId, from: range.from, to: range.to, staffIds: staffFilter }),
    enabled: !!branchId,
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });
  const data = calendar.data;

  const move = useMutation({
    mutationFn: ({ req, notify }: { req: MoveRequest; notify: boolean }) => {
      const a = req.item.appointment;
      const targetStaff = group === 'staff' && view === 'day' ? req.column.staffId : view === 'week' ? req.item.item.staffId ?? undefined : undefined;
      return api.post<AppointmentDto>(`/appointments/${a.id}/move`, { version: a.version, itemId: req.item.item.id, startAt: toInstant(req.column.date, hhmm(req.startMin), timezone), staffId: targetStaff && targetStaff !== req.item.item.staffId ? targetStaff : undefined, notifyCustomer: notify });
    },
    onMutate: ({ req }) => setBusyKey(req.item.key),
    onSuccess: (a, { req }) => {
      toast.success(`Moved ${a.customer.fullName.split(' ')[0]} to ${fmtTime(req.item.item.startAt ? toInstant(req.column.date, hhmm(req.startMin), timezone) : a.startAt, timezone)}`, { description: req.column.staffId && req.column.staffId !== req.item.item.staffId ? `Now with ${req.column.label}` : undefined });
    },
    onError: toastError,
    onSettled: () => {
      setBusyKey(null);
      refresh();
    },
  });

  const resize = useMutation({
    mutationFn: (req: ResizeRequest) => {
      const a = req.item.appointment;
      return api.post<AppointmentDto>(`/appointments/${a.id}/move`, { version: a.version, itemId: req.item.item.id, startAt: req.item.item.startAt!, durationMinutes: req.durationMinutes, notifyCustomer: false });
    },
    onMutate: (req) => setBusyKey(req.item.key),
    onSuccess: (_a, req) => toast.success(`Duration set to ${req.durationMinutes} minutes`),
    onError: toastError,
    onSettled: () => {
      setBusyKey(null);
      refresh();
    },
  });

  // ───────── Build grid columns and items for the day / week views ─────────
  const grid = useMemo(() => {
    if (!data || view === 'month') return null;
    const dates = view === 'day' ? [date] : Array.from({ length: 7 }, (_, i) => addDaysTo(range.from, i));
    const hoursFor = (d: string) => data.branchHours.find((h) => h.weekday === weekdayOf(d));
    const holiday = (d: string) => data.holidays.find((h) => h.date === d)?.name ?? null;
    const closedLabel = (d: string) => holiday(d) ?? (hoursFor(d)?.isClosed ? 'Salon closed' : null);
    const branchShift = (d: string) => {
      const h = hoursFor(d);
      return h && !h.isClosed && h.openTime && h.closeTime ? [{ start: toMin(h.openTime), end: toMin(h.closeTime) }] : [];
    };

    let columns: GridColumn[] = [];
    let items: GridItem[] = [];
    const entries = data.appointments.flatMap((a) => a.items.filter((i) => i.startAt && i.endAt && ['pending', 'in_service', 'completed'].includes(i.status)).map((i) => ({ a, i })));

    if (view === 'day' && group === 'staff') {
      columns = data.resources.map((r) => {
        const leave = r.leave.find((l) => l.date === date);
        return {
          key: r.staffId,
          label: r.displayName,
          color: r.color,
          photo: r.photoUrl,
          date,
          staffId: r.staffId,
          shifts: r.shifts.filter((s) => s.date === date).map((s) => ({ start: toMin(s.start), end: toMin(s.end) })),
          breaks: r.breaks.filter((b) => b.date === date).map((b) => ({ start: toMin(b.start), end: toMin(b.end), label: b.label })),
          blocks: r.blocks.filter((b) => localDate(b.start, timezone) === date).map((b) => ({ id: b.id, start: minutesOfDay(b.start, timezone), end: Math.min(minutesOfDay(b.end, timezone) || 1440, 1440), reason: b.reason })),
          leave: leave ? (leave.halfDay === 'none' ? 'full' : leave.halfDay === 'first_half' ? 'first_half' : 'second_half') : null,
          attendance: r.attendance,
          closed: closedLabel(date),
        } satisfies GridColumn;
      });
      items = entries.filter(({ i }) => i.staffId).map(({ a, i }) => toItem(a, i, i.staffId!, timezone));
    } else if (view === 'day') {
      const services = new Map<string, string>();
      for (const { i } of entries) services.set(i.serviceId, i.serviceName);
      columns = [...services.entries()].sort((x, y) => x[1].localeCompare(y[1])).map(([id, name]) => ({ key: id, label: name, date, shifts: branchShift(date), breaks: [], blocks: [], leave: null, closed: closedLabel(date) }));
      items = entries.map(({ a, i }) => toItem(a, i, i.serviceId, timezone));
    } else {
      const only = staffFilter.length === 1 ? data.resources.find((r) => r.staffId === staffFilter[0]) : null;
      columns = dates.map((d) => {
        const r = only;
        const leave = r?.leave.find((l) => l.date === d);
        return {
          key: d,
          label: fmtDay(d, timezone).split(',')[0]!,
          sublabel: fmtDay(d, timezone).split(',')[1]?.trim(),
          date: d,
          staffId: r?.staffId,
          shifts: r ? r.shifts.filter((s) => s.date === d).map((s) => ({ start: toMin(s.start), end: toMin(s.end) })) : branchShift(d),
          breaks: r ? r.breaks.filter((b) => b.date === d).map((b) => ({ start: toMin(b.start), end: toMin(b.end), label: b.label })) : [],
          blocks: [],
          leave: leave ? (leave.halfDay === 'none' ? 'full' : leave.halfDay === 'first_half' ? 'first_half' : 'second_half') : null,
          closed: closedLabel(d),
        } satisfies GridColumn;
      });
      items = entries.filter(({ i }) => !only || i.staffId === only.staffId).map(({ a, i }) => toItem(a, i, localDate(i.startAt!, timezone), timezone));
    }

    // Visible hours: the salon's opening window across the shown days, widened if an appointment falls outside it.
    const opens = dates.flatMap((d) => branchShift(d));
    let start = opens.length ? Math.min(...opens.map((o) => o.start)) : 9 * 60;
    let end = opens.length ? Math.max(...opens.map((o) => o.end)) : 21 * 60;
    for (const it of items) {
      start = Math.min(start, it.startMin);
      end = Math.max(end, it.endMin);
    }
    start = Math.max(0, Math.floor((start - 30) / 60) * 60);
    end = Math.min(24 * 60, Math.ceil((end + 30) / 60) * 60);
    return { columns, items, rangeStart: start, rangeEnd: end };
  }, [data, view, group, date, range.from, staffFilter, timezone]);

  const slotMinutes = user.preferences?.slotIntervalMinutes ?? 15;
  const editable = can('appointments.update');
  const dragAllowed = editable && ((view === 'day' && group === 'staff') || (view === 'week' && staffFilter.length === 1));
  const nowMin = minutesOfDay(new Date(), timezone);

  const step = (dir: -1 | 1) => set({ date: addDaysTo(date, dir * (view === 'day' ? 1 : view === 'week' ? 7 : 30)) });
  const title = view === 'day' ? fmtDay(date, timezone, true) : view === 'week' ? `${fmtDay(range.from, timezone)} – ${fmtDay(range.to, timezone, true)}` : new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  const askMove = (req: MoveRequest) => {
    // Customers who are already here (checked in) don't need a message; otherwise confirm and let the receptionist decide.
    setPendingMove(req);
  };

  return (
    <div>
      <PageHeader
        title="Calendar"
        description={`${branch.name} · times shown in the salon's local time`}
        actions={
          <>
            {can('walkins.manage') && <Button variant="outline" icon={<DoorOpen className="size-4" />} hotkey="W" onClick={() => quick.walkIn()}>Walk-in</Button>}
            {can('appointments.create') && <Button icon={<CalendarPlus className="size-4" />} hotkey="N" onClick={() => quick.newAppointment({ branchId, date })}>New appointment</Button>}
          </>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <IconButton label="Previous" variant="outline" onClick={() => step(-1)}><ChevronLeft className="size-5" /></IconButton>
          <Button variant="outline" onClick={() => set({ date: today })} disabled={date === today && view === 'day'}>Today</Button>
          <IconButton label="Next" variant="outline" onClick={() => step(1)}><ChevronRight className="size-5" /></IconButton>
        </div>
        <h2 className="min-w-40 text-lg font-semibold">{title}</h2>
        <DateInput aria-label="Go to date" className="w-40" value={date} onChange={(e) => e.target.value && set({ date: e.target.value })} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Segmented label="Calendar view" value={view} onChange={(v) => set({ view: v })} options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} />
          {view === 'day' && <Segmented label="Group by" value={group} onChange={(v) => set({ group: v })} options={[{ value: 'staff', label: 'By team' }, { value: 'service', label: 'By service' }]} />}
          <Popover align="end" trigger={<Button variant="outline" icon={<Users className="size-4" />}>{staffFilter.length ? `${staffFilter.length} selected` : 'Everyone'}</Button>}>
            <p className="mb-2 text-sm font-medium">Show team members</p>
            <div className="max-h-64 space-y-2 overflow-y-auto">
              {(data?.resources ?? []).map((r) => (
                <Checkbox key={r.staffId} checked={staffFilter.includes(r.staffId)} onCheckedChange={(v) => set({ staff: (v ? [...staffFilter, r.staffId] : staffFilter.filter((x) => x !== r.staffId)).join(',') })} label={r.displayName} />
              ))}
            </div>
            {staffFilter.length > 0 && <Button size="sm" variant="ghost" className="mt-2" onClick={() => set({ staff: null })}>Show everyone</Button>}
          </Popover>
        </div>
      </div>

      <div className="mb-3 hidden flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted md:flex" aria-label="Colour key">
        {[['Scheduled', 'bg-info'], ['Confirmed', 'bg-primary'], ['Checked in', 'bg-warning'], ['In service', 'bg-success'], ['Completed', 'bg-line-strong']].map(([l, c]) => (
          <span key={l} className="inline-flex items-center gap-1.5"><span className={cn('size-2.5 rounded-sm', c)} />{l}</span>
        ))}
        <span className="inline-flex items-center gap-1.5"><span className="hatch size-3 rounded-sm border border-line" />Not working</span>
        {dragAllowed && <span className="ml-auto">Drag a booking to move it. Drag its bottom edge to change the length.</span>}
      </div>

      {calendar.isError && !data && <Card><ErrorState error={calendar.error} onRetry={() => void calendar.refetch()} /></Card>}
      {calendar.isLoading && !data && <div role="status" aria-label="Loading calendar" className="skeleton h-96" />}

      {data && view === 'month' && <MonthView data={data} date={date} tz={timezone} today={today} onPick={(d) => set({ view: 'day', date: d })} />}

      {grid && (
        <>
          {/* Phones get a clear agenda instead of a shrunken grid. */}
          <div className="md:hidden">
            <Agenda items={grid.items} date={date} view={view} tz={timezone} resources={data?.resources ?? []} onSelect={(a) => setOpenId(a.id)} onNew={() => quick.newAppointment({ branchId, date })} canCreate={can('appointments.create')} />
          </div>
          <div className="max-md:hidden">
            {grid.columns.length === 0 ? (
              <Card><EmptyState title={group === 'service' ? 'No services booked on this day' : 'No team members to show'} description={group === 'service' ? 'Book an appointment and it will appear here.' : 'Add team members under Team, or clear the filter.'} action={can('appointments.create') && <Button onClick={() => quick.newAppointment({ branchId, date })}>New appointment</Button>} /></Card>
            ) : (
              <CalendarGrid
                columns={grid.columns}
                items={grid.items}
                rangeStart={grid.rangeStart}
                rangeEnd={grid.rangeEnd}
                slotMinutes={slotMinutes}
                canEdit={dragAllowed}
                showNow={date === today || (view === 'week' && range.from <= today && today <= range.to) ? { date: today, minutes: nowMin } : null}
                busyKey={busyKey}
                emptyBanner={view === 'day' ? grid.columns[0]?.closed && group === 'staff' ? `${grid.columns[0].closed} — no bookings can be made today.` : null : null}
                onSelect={(a) => setOpenId(a.id)}
                onSlotClick={(col, minute) => can('appointments.create') && quick.newAppointment({ branchId, date: col.date, staffId: col.staffId, startAt: toInstant(col.date, hhmm(minute), timezone) })}
                onMove={askMove}
                onResize={(r) => resize.mutate(r)}
              />
            )}
          </div>
        </>
      )}

      {openId && <AppointmentDrawer id={openId} onClose={() => { setOpenId(null); void client.invalidateQueries({ queryKey: ['calendar'] }); }} />}
      {pendingMove && <MoveConfirm req={pendingMove} tz={timezone} onCancel={() => setPendingMove(null)} onConfirm={(notify) => { move.mutate({ req: pendingMove, notify }); setPendingMove(null); }} />}
    </div>
  );
}

function toItem(a: AppointmentDto, i: AppointmentItemDto, columnKey: string, tz: string): GridItem {
  const start = minutesOfDay(i.startAt!, tz);
  const end = start + i.durationMinutes;
  return { key: i.id, columnKey, startMin: start, endMin: end, appointment: a, item: i };
}

function MoveConfirm({ req, tz, onConfirm, onCancel }: { req: MoveRequest; tz: string; onConfirm: (notify: boolean) => void; onCancel: () => void }) {
  const a = req.item.appointment;
  const [notify, setNotify] = useState(a.status !== 'checked_in');
  const newTime = fmtMinLabel(req.startMin);
  const staffChanged = req.column.staffId && req.column.staffId !== req.item.item.staffId;
  const dateChanged = req.column.date !== localDate(req.item.item.startAt!, tz);
  return (
    <Modal open onOpenChange={(o) => !o && onCancel()} title="Move this appointment?" size="sm" footer={<><Button variant="outline" onClick={onCancel}>Keep as it is</Button><Button onClick={() => onConfirm(notify)}>Move appointment</Button></>}>
      <div className="space-y-4 text-sm">
        <div className="rounded-lg bg-surface-2 p-3">
          <p className="font-semibold">{a.customer.fullName}</p>
          <p className="text-muted">{req.item.item.serviceName}</p>
        </div>
        <dl className="space-y-1.5">
          <div className="flex justify-between"><dt className="text-muted">From</dt><dd>{fmtDay(req.item.item.startAt, tz)}, {fmtTime(req.item.item.startAt, tz)} · {req.item.item.staffName}</dd></div>
          <div className="flex justify-between font-medium"><dt className="text-muted">To</dt><dd>{dateChanged ? `${fmtDay(req.column.date, tz)}, ` : ''}{newTime}{staffChanged ? ` · ${req.column.label}` : ` · ${req.item.item.staffName}`}</dd></div>
        </dl>
        <Switch checked={notify} onCheckedChange={setNotify} label="Tell the customer" description="This will notify the customer if notifications are enabled for them." />
      </div>
    </Modal>
  );
}

function MonthView({ data, date, tz, today, onPick }: { data: CalendarData; date: string; tz: string; today: string; onPick: (d: string) => void }) {
  const first = startOfMonth(date);
  const gridStart = startOfWeek(first);
  const days = Array.from({ length: 42 }, (_, i) => addDaysTo(gridStart, i));
  const byDay = new Map<string, AppointmentDto[]>();
  for (const a of data.appointments) byDay.set(a.localDate, [...(byDay.get(a.localDate) ?? []), a]);
  return (
    <Card padded={false}>
      <div className="grid grid-cols-7 border-b border-line text-center text-xs font-medium text-muted">
        {[1, 2, 3, 4, 5, 6, 7].map((d) => <div key={d} className="py-2">{WEEKDAY_SHORT[d]}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const inMonth = d.slice(0, 7) === first.slice(0, 7);
          const list = (byDay.get(d) ?? []).sort((a, b) => (a.startAt ?? '').localeCompare(b.startAt ?? ''));
          const holiday = data.holidays.find((h) => h.date === d);
          return (
            <button key={d} type="button" onClick={() => onPick(d)} aria-label={`${fmtDay(d, tz, true)}, ${list.length} appointments`} className={cn('min-h-24 border-b border-r border-line p-1.5 text-left align-top hover:bg-surface-2 max-md:min-h-16', !inMonth && 'bg-surface-2/50 text-faint', d === today && 'bg-primary-soft/40')}>
              <div className="flex items-center justify-between">
                <span className={cn('grid size-6 place-items-center rounded-full text-xs font-medium', d === today && 'bg-primary text-primary-fg')}>{Number(d.slice(8))}</span>
                {list.length > 0 && <Badge tone="primary">{list.length}</Badge>}
              </div>
              {holiday && <p className="mt-1 truncate text-[10px] font-medium text-warning">{holiday.name}</p>}
              <ul className="mt-1 hidden space-y-0.5 md:block">
                {list.slice(0, 3).map((a) => (
                  <li key={a.id} className="truncate text-[11px] text-muted"><span className="font-medium text-fg">{fmtTime(a.startAt, tz)}</span> {a.customer.fullName.split(' ')[0]}</li>
                ))}
                {list.length > 3 && <li className="text-[11px] text-faint">+{list.length - 3} more</li>}
              </ul>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function Agenda({ items, date, view, tz, resources, onSelect, onNew, canCreate }: { items: GridItem[]; date: string; view: View; tz: string; resources: CalendarData['resources']; onSelect: (a: AppointmentDto) => void; onNew: () => void; canCreate: boolean }) {
  const sorted = [...items].sort((a, b) => (a.item.startAt ?? '').localeCompare(b.item.startAt ?? ''));
  const away = resources.filter((r) => r.leave.some((l) => l.date === date && l.halfDay === 'none') || r.attendance === 'absent');
  if (sorted.length === 0) return <Card><EmptyState title={view === 'day' ? 'No appointments for this day' : 'No appointments this week'} description="You can create a new appointment or add a walk-in customer." action={canCreate && <Button onClick={onNew}>New appointment</Button>} /></Card>;
  let lastDay = '';
  return (
    <div className="space-y-2">
      {away.length > 0 && <p className="rounded-lg bg-info-soft px-3 py-2 text-sm text-info">Away: {away.map((r) => r.displayName).join(', ')}</p>}
      {sorted.map((it) => {
        const day = localDate(it.item.startAt!, tz);
        const heading = view === 'week' && day !== lastDay ? fmtDay(day, tz) : null;
        lastDay = day;
        return (
          <div key={it.key}>
            {heading && <p className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide text-muted">{heading}</p>}
            <button type="button" onClick={() => onSelect(it.appointment)} className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface p-3 text-left shadow-card active:bg-surface-2">
              <span className="h-12 w-1.5 rounded-full" style={{ background: it.item.staffColor ?? 'var(--primary)' }} aria-hidden />
              <div className="w-16 shrink-0 text-sm font-semibold tabular-nums">{fmtTime(it.item.startAt, tz)}</div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{it.appointment.customer.fullName}</p>
                <p className="truncate text-xs text-muted">{it.item.serviceName} · {it.item.staffName}</p>
              </div>
              <StatusBadge status={it.appointment.status} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
