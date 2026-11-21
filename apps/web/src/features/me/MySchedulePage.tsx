import { HALF_DAY_OPTIONS, LEAVE_TYPES, leaveRequestSchema, type AttendanceDayDto, type LeaveStatus, type MyScheduleDay } from '@salon/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarOff, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { toastError } from '@/app/providers';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardHeader, EmptyState, ErrorState, InlineNotice, PageHeader, Skeleton, type Tone } from '@/components/ui/display';
import { DateInput, Field, FormError, Select, Textarea } from '@/components/ui/form';
import { Modal } from '@/components/ui/overlay';
import { api, ApiError } from '@/lib/api';
import { friendlyError } from '@/lib/errors';
import { addDaysTo, fmtDay, fmtTime, todayIn } from '@/lib/format';
import { HALF_DAY_LABEL, LEAVE_STATUS, LEAVE_TYPE_LABEL } from '@/lib/leave';
import { cn } from '@/lib/utils';

interface Schedule { staff: { id: string; displayName: string; branchName: string }; timezone: string; days: MyScheduleDay[] }
interface MyLeave { id: string; leaveType: string; startDate: string; endDate: string; halfDay: string; reason: string | null; status: LeaveStatus; decidedByName: string | null; decidedAt: string | null; createdAt: string }
interface Booking { appointmentId: string; bookingNumber: string; startAt: string; customerName: string; serviceName: string }

const DAY_STATUS: Record<MyScheduleDay['status'], { label: string; tone: Tone }> = {
  working: { label: 'Working', tone: 'success' },
  half_leave: { label: 'Half-day leave', tone: 'warning' },
  leave: { label: 'On leave', tone: 'warning' },
  day_off: { label: 'Day off', tone: 'neutral' },
  holiday: { label: 'Holiday', tone: 'info' },
  branch_closed: { label: 'Salon closed', tone: 'neutral' },
};
const ATTENDANCE_TONE: Record<string, Tone> = { present: 'success', late: 'warning', absent: 'danger', half_day: 'warning', on_leave: 'info', missing_punch: 'warning' };

const time12 = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

/** A team member's own calendar of work: when they work, days off and leave, asking for leave, and their attendance. */
export function Component() {
  const [asking, setAsking] = useState(false);
  const schedule = useQuery({ queryKey: ['my-schedule'], queryFn: () => api.get<Schedule>('/me/schedule') });
  const leaves = useQuery({ queryKey: ['my-leaves'], queryFn: () => api.get<MyLeave[]>('/me/leaves') });
  const attendance = useQuery({ queryKey: ['my-attendance'], queryFn: () => api.get<AttendanceDayDto[]>('/me/attendance') });
  const tz = schedule.data?.timezone ?? 'Asia/Kolkata';
  const today = todayIn(tz);
  const shown = (attendance.data ?? []).filter((d) => !['weekly_off', 'holiday', 'not_started'].includes(d.status)).sort((a, b) => b.date.localeCompare(a.date));
  const count = (s: string) => shown.filter((d) => d.status === s).length;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PageHeader title="My schedule & leave" description={schedule.data ? `${schedule.data.staff.displayName} · ${schedule.data.staff.branchName}` : undefined} actions={<Button icon={<Plus className="size-4" />} onClick={() => setAsking(true)}>Ask for leave</Button>} />
      {schedule.isError && <ErrorState error={schedule.error} onRetry={() => void schedule.refetch()} />}

      <Card padded={false}>
        <div className="p-4 pb-2"><CardHeader title="Next two weeks" description="Your hours, days off and leave. Booked appointments are counted per day." /></div>
        {schedule.isLoading ? <div className="space-y-2 p-4"><Skeleton className="h-10" /><Skeleton className="h-10" /></div> : (
          <ul className="divide-y divide-line">
            {schedule.data?.days.map((d) => (
              <li key={d.date} className={cn('px-4 py-2.5 text-sm', d.date === today && 'bg-primary-soft/40')}>
                <div className="flex items-center gap-3">
                  <span className="w-28 shrink-0 font-medium">{d.date === today ? 'Today' : fmtDay(d.date, tz)}</span>
                  <Badge tone={DAY_STATUS[d.status].tone}>{d.status === 'leave' && d.leaveType ? LEAVE_TYPE_LABEL[d.leaveType] : d.status === 'holiday' && d.holiday ? d.holiday : DAY_STATUS[d.status].label}</Badge>
                  {d.appointments > 0 && <span className="ml-auto text-xs font-medium text-fg">{d.appointments} {d.appointments === 1 ? 'appointment' : 'appointments'}</span>}
                </div>
                {d.hours.length > 0 && (
                  <p className="mt-0.5 text-muted sm:pl-[7.75rem]">
                    {d.hours.map((h) => `${time12(h.start)} – ${time12(h.end)}`).join(', ')}
                    {d.breaks.length > 0 && ` · break ${d.breaks.map((b) => time12(b.start)).join(', ')}`}
                    {d.blocks.length > 0 && ` · ${d.blocks.map((b) => `${b.reason} ${time12(b.start)}`).join(', ')}`}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card padded={false}>
        <div className="p-4 pb-2"><CardHeader title="My leave" description="Requests wait for your manager. You can withdraw one until it is answered." /></div>
        {leaves.isLoading ? <div className="p-4"><Skeleton className="h-12" /></div> : (leaves.data ?? []).length === 0 ? <EmptyState title="No leave yet" description="Ask for leave and your manager will approve or decline it." /> : (
          <ul className="divide-y divide-line">{leaves.data!.map((l) => <LeaveRow key={l.id} leave={l} tz={tz} />)}</ul>
        )}
      </Card>

      <Card padded={false}>
        <div className="p-4 pb-2"><CardHeader title="Attendance" description="The last 30 days, from the attendance machine." /></div>
        {attendance.isLoading ? <div className="p-4"><Skeleton className="h-12" /></div> : shown.length === 0 ? <p className="px-4 pb-4 text-sm text-muted">No attendance recorded in the last 30 days.</p> : (
          <>
            <p className="px-4 pb-2 text-sm text-muted">{count('present')} present · {count('late')} late · {count('absent')} absent{count('missing_punch') ? ` · ${count('missing_punch')} missing punch` : ''}</p>
            <ul className="scroll-thin max-h-72 divide-y divide-line overflow-y-auto">
              {shown.map((d) => (
                <li key={d.date} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <span className="w-28 shrink-0">{fmtDay(d.date, tz)}</span>
                  <Badge tone={ATTENDANCE_TONE[d.status] ?? 'neutral'}>{d.status.replace('_', ' ')}</Badge>
                  <span className="text-muted">{d.firstIn ? `In ${fmtTime(d.firstIn, tz)}` : ''}{d.lastOut ? ` · out ${fmtTime(d.lastOut, tz)}` : ''}{d.lateMinutes > 0 ? ` · ${d.lateMinutes} min late` : ''}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      {asking && <AskLeaveModal tz={tz} onClose={() => setAsking(false)} />}
    </div>
  );
}

function LeaveRow({ leave: l, tz }: { leave: MyLeave; tz: string }) {
  const client = useQueryClient();
  const withdraw = useMutation({
    mutationFn: () => api.post(`/me/leaves/${l.id}/cancel`),
    onSuccess: () => { toast.success('Leave request withdrawn'); void client.invalidateQueries({ queryKey: ['my-leaves'] }); },
    onError: toastError,
  });
  const dates = l.startDate === l.endDate ? fmtDay(l.startDate, tz, true) : `${fmtDay(l.startDate, tz)} – ${fmtDay(l.endDate, tz, true)}`;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
      <CalendarOff className="size-4 shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{dates}{l.halfDay !== 'none' ? ` · ${HALF_DAY_LABEL[l.halfDay]}` : ''}</span>
        <span className="block text-xs text-muted">{LEAVE_TYPE_LABEL[l.leaveType] ?? l.leaveType}{l.reason ? ` · ${l.reason}` : ''}{l.decidedByName && l.status !== 'cancelled' ? ` · answered by ${l.decidedByName}` : ''}</span>
      </span>
      <Badge tone={LEAVE_STATUS[l.status].tone}>{LEAVE_STATUS[l.status].label}</Badge>
      {l.status === 'pending' && <Button size="sm" variant="ghost" loading={withdraw.isPending} onClick={() => withdraw.mutate()}>Withdraw</Button>}
    </li>
  );
}

function AskLeaveModal({ tz, onClose }: { tz: string; onClose: () => void }) {
  const client = useQueryClient();
  const today = todayIn(tz);
  const [v, setV] = useState({ leaveType: 'casual', startDate: addDaysTo(today, 1), endDate: addDaysTo(today, 1), halfDay: 'none', reason: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const set = (patch: Partial<typeof v>) => { setV((x) => ({ ...x, ...patch })); setErrors({}); };
  const send = useMutation({
    mutationFn: () => {
      const parsed = leaveRequestSchema.safeParse(v);
      if (!parsed.success) {
        const errs: Record<string, string> = {};
        for (const i of parsed.error.issues) errs[String(i.path[0])] ??= i.message;
        setErrors(errs);
        throw new Error('Please fix the highlighted fields.');
      }
      return api.post<{ bookings: Booking[] }>('/me/leaves', parsed.data);
    },
    onSuccess: (r) => {
      void client.invalidateQueries({ queryKey: ['my-leaves'] });
      toast.success('Leave asked for', { description: 'Your manager will approve or decline it.' });
      if (r.bookings.length) setBookings(r.bookings);
      else onClose();
    },
    onError: (e) => { if (e instanceof ApiError) setErrors(e.fieldErrors); },
  });

  if (bookings) {
    return (
      <Modal open onOpenChange={(o) => !o && onClose()} title="Leave asked for" footer={<Button onClick={onClose}>Done</Button>}>
        <InlineNotice tone="warning" title={`You have ${bookings.length} ${bookings.length === 1 ? 'booking' : 'bookings'} on those dates`}>If your leave is approved, the front desk will move them to someone else or another time.</InlineNotice>
        <ul className="mt-3 divide-y divide-line text-sm">{bookings.map((b) => <li key={b.appointmentId} className="py-2"><span className="font-medium">{fmtDay(b.startAt, tz)}, {fmtTime(b.startAt, tz)}</span> · {b.customerName} · {b.serviceName}</li>)}</ul>
      </Modal>
    );
  }
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Ask for leave" description="Your manager approves or declines it. You can withdraw it until then." size="sm" persistent footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={send.isPending} onClick={() => send.mutate()}>Send request</Button></>}>
      <div className="space-y-4">
        <FormError message={send.error && !(send.error instanceof ApiError && Object.keys(send.error.fieldErrors).length) ? friendlyError(send.error).message : null} />
        <Field label="Type of leave"><Select value={v.leaveType} onChange={(e) => set({ leaveType: e.target.value })}>{LEAVE_TYPES.map((t) => <option key={t} value={t}>{LEAVE_TYPE_LABEL[t]}</option>)}</Select></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From" required error={errors.startDate}><DateInput value={v.startDate} min={today} onChange={(e) => set({ startDate: e.target.value, endDate: v.endDate < e.target.value ? e.target.value : v.endDate })} /></Field>
          <Field label="To" required error={errors.endDate}><DateInput value={v.endDate} min={v.startDate} onChange={(e) => set({ endDate: e.target.value })} /></Field>
        </div>
        <Field label="Length" error={errors.halfDay} hint="Half days are for a single date."><Select value={v.halfDay} onChange={(e) => set({ halfDay: e.target.value })}>{HALF_DAY_OPTIONS.map((h) => <option key={h} value={h}>{HALF_DAY_LABEL[h]}</option>)}</Select></Field>
        <Field label="Reason" optional><Textarea rows={2} value={v.reason} maxLength={500} onChange={(e) => set({ reason: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}
