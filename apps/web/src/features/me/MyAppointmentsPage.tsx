import type { AppointmentDto, ChangeRequestDto } from '@salon/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Phone } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { toastError } from '@/app/providers';
import { StatusBadge } from '@/components/common/badges';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, ErrorState, InlineNotice, PageHeader, Skeleton } from '@/components/ui/display';
import { DateInput, Field, FormError, Segmented, Textarea } from '@/components/ui/form';
import { Modal } from '@/components/ui/overlay';
import { api } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { friendlyError } from '@/lib/errors';
import { addDaysTo, fmtDay, fmtDuration, fmtTime, localDate, todayIn } from '@/lib/format';
import { cn } from '@/lib/utils';

type View = 'upcoming' | 'past';

/** A team member's own bookings: what is coming up (with "ask to reschedule") and what they have done. */
export function Component() {
  const user = useUser();
  const { timezone: tz } = useBranch();
  const today = todayIn(tz);
  const [view, setView] = useState<View>('upcoming');
  const [moving, setMoving] = useState<AppointmentDto | null>(null);
  const range = view === 'upcoming' ? { from: today, to: addDaysTo(today, 60), sortDir: 'asc' } : { from: addDaysTo(today, -90), to: today, sortDir: 'desc' };
  const list = useQuery({ queryKey: ['my-appointments', view, range.from], queryFn: () => api.list<AppointmentDto>('/appointments', { ...range, pageSize: 100 }) });
  const requests = useQuery({ queryKey: ['my-change-requests'], queryFn: () => api.get<ChangeRequestDto[]>('/me/change-requests') });

  const mine = (a: AppointmentDto) => a.items.filter((i) => i.staffId === user.staffId);
  const startOf = (a: AppointmentDto) => mine(a)[0]?.startAt ?? a.startAt;
  // Upcoming: still to happen (today's finished ones are history). Past: done, cancelled or missed.
  const finished = (a: AppointmentDto) => ['completed', 'cancelled', 'no_show'].includes(a.status);
  const rows = (list.data?.rows ?? []).filter((a) => (view === 'upcoming' ? !finished(a) : finished(a))).sort((a, b) => (view === 'upcoming' ? 1 : -1) * (startOf(a) ?? '').localeCompare(startOf(b) ?? ''));
  const days = [...new Set(rows.map((a) => (startOf(a) ? localDate(startOf(a)!, tz) : a.localDate)))];

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title="My appointments" description={view === 'upcoming' ? 'Everything booked with you for the next two months.' : 'What you did in the last three months.'} actions={<Segmented label="Which appointments" value={view} onChange={setView} options={[{ value: 'upcoming', label: 'Upcoming' }, { value: 'past', label: 'Past' }]} />} />
      {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
      {list.isLoading && <div role="status" aria-label="Loading appointments" className="space-y-2"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>}
      {list.data && rows.length === 0 && <Card><EmptyState title={view === 'upcoming' ? 'Nothing booked yet' : 'No appointments in the last three months'} description={view === 'upcoming' ? 'New bookings with you will show here.' : undefined} /></Card>}
      {days.map((day) => (
        <section key={day} aria-label={fmtDay(day, tz)}>
          <h2 className="mb-2 text-sm font-semibold">{day === today ? 'Today' : day === addDaysTo(today, 1) ? 'Tomorrow' : fmtDay(day, tz)}</h2>
          <ul className="space-y-2">
            {rows.filter((a) => (startOf(a) ? localDate(startOf(a)!, tz) : a.localDate) === day).map((a) => {
              const request = requests.data?.find((r) => r.appointmentId === a.id && (r.status === 'pending' || (r.status === 'declined' && r.currentStartAt === startOf(a))));
              const canMove = view === 'upcoming' && ['scheduled', 'confirmed'].includes(a.status) && !request?.status.match(/pending/);
              return (
                <li key={a.id}>
                  <AppointmentCard appointment={a} services={mine(a).map((i) => i.serviceName).join(', ')} start={startOf(a)} minutes={mine(a).reduce((s, i) => s + i.durationMinutes, 0)} tz={tz} request={request ?? null} onMove={canMove ? () => setMoving(a) : undefined} />
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {moving && <RescheduleModal appointment={moving} start={startOf(moving)} tz={tz} onClose={() => setMoving(null)} />}
    </div>
  );
}

function AppointmentCard({ appointment: a, services, start, minutes, tz, request, onMove }: { appointment: AppointmentDto; services: string; start: string | null; minutes: number; tz: string; request: ChangeRequestDto | null; onMove?: () => void }) {
  const client = useQueryClient();
  const withdraw = useMutation({
    mutationFn: (id: string) => api.post(`/me/change-requests/${id}/cancel`),
    onSuccess: () => { toast.success('Request withdrawn'); void client.invalidateQueries({ queryKey: ['my-change-requests'] }); },
    onError: toastError,
  });
  return (
    <div className="rounded-xl border border-line bg-surface p-3 shadow-card">
      <div className="flex items-start gap-3">
        <div className="w-16 shrink-0 text-center">
          <p className="text-base font-semibold tabular-nums">{fmtTime(start, tz)}</p>
          <p className="text-[11px] text-muted">{fmtDuration(minutes)}</p>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{a.customer.fullName}</p>
          <p className="truncate text-sm text-muted">{services}</p>
          {a.customer.mobile && <p className="flex items-center gap-1 text-xs text-faint"><Phone className="size-3" aria-hidden />{a.customer.mobile}</p>}
          {a.notes && <p className="mt-1.5 rounded-lg bg-surface-2 p-2 text-sm">{a.notes}</p>}
        </div>
        <StatusBadge status={a.status} />
      </div>
      {request?.status === 'pending' && (
        <InlineNotice tone="warning" title={`Waiting for the front desk: move to ${fmtDay(request.proposedStartAt, tz)}, ${fmtTime(request.proposedStartAt, tz)}`} action={<Button size="sm" variant="outline" loading={withdraw.isPending} onClick={() => withdraw.mutate(request.id)}>Withdraw</Button>}>
          {request.reason ?? undefined}
        </InlineNotice>
      )}
      {request?.status === 'declined' && (
        <p className="mt-2 text-xs text-danger">The front desk kept this time{request.decisionNote ? `: ${request.decisionNote}` : '.'}</p>
      )}
      {onMove && (
        <div className="mt-2 flex justify-end">
          <Button size="sm" variant="ghost" icon={<CalendarClock className="size-4" />} onClick={onMove}>Ask to reschedule</Button>
        </div>
      )}
    </div>
  );
}

/** Pick a new time when you are free; the front desk approves it and the customer is told. */
function RescheduleModal({ appointment: a, start, tz, onClose }: { appointment: AppointmentDto; start: string | null; tz: string; onClose: () => void }) {
  const client = useQueryClient();
  const today = todayIn(tz);
  const [date, setDate] = useState(start ? localDate(start, tz) : today);
  const [slot, setSlot] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const slots = useQuery({ queryKey: ['my-slots', a.id, date], queryFn: () => api.get<{ slots: string[]; label: string | null; holiday: string | null; branchOpen: boolean }>(`/me/appointments/${a.id}/slots`, { date }) });
  const offered = (slots.data?.slots ?? []).filter((s) => s !== start);
  const send = useMutation({
    mutationFn: () => api.post<ChangeRequestDto>('/me/change-requests', { appointmentId: a.id, proposedStartAt: slot, reason: reason.trim() || undefined }),
    onSuccess: () => { toast.success('Sent to the front desk', { description: 'You will see their answer here.' }); void client.invalidateQueries({ queryKey: ['my-change-requests'] }); onClose(); },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Ask to reschedule ${a.customer.fullName}`} description={`Now ${fmtDay(start, tz)} at ${fmtTime(start, tz)}. The front desk approves the change and tells the customer.`} footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!slot} loading={send.isPending} onClick={() => send.mutate()}>Send request</Button></>}>
      <div className="space-y-4">
        <FormError message={send.error ? friendlyError(send.error).message : null} />
        <Field label="Day"><DateInput value={date} min={today} onChange={(e) => { setDate(e.target.value); setSlot(null); }} /></Field>
        <div>
          <p className="mb-1.5 text-sm font-medium">Times you are free</p>
          {slots.isLoading ? <Skeleton className="h-16" /> : slots.data?.holiday ? <p className="text-sm text-muted">The salon is closed for {slots.data.holiday}.</p> : offered.length === 0 ? <p className="text-sm text-muted">{slots.data?.label ?? 'No free time that day.'} Try another day.</p> : (
            <div role="radiogroup" aria-label="New time" className="flex flex-wrap gap-2">
              {offered.map((s) => (
                <button key={s} type="button" role="radio" aria-checked={slot === s} onClick={() => setSlot(s)} className={cn('rounded-lg border px-3 py-2 text-sm font-medium tabular-nums max-md:min-h-11', slot === s ? 'border-primary bg-primary-soft text-primary-soft-fg' : 'border-line hover:border-primary/50')}>{fmtTime(s, tz)}</button>
              ))}
            </div>
          )}
        </div>
        <Field label="Why?" optional hint="Helps the front desk explain it to the customer."><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
      </div>
    </Modal>
  );
}
