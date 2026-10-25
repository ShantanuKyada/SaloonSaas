import type { AppointmentDto, AppointmentStatus, AvailabilityResult } from '@salon/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { toastError } from '@/app/providers';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/display';
import { DateInput, Field, Switch } from '@/components/ui/form';
import { Modal } from '@/components/ui/overlay';
import { api } from '@/lib/api';
import { fmtDay, fmtTime, localDate, todayIn } from '@/lib/format';
import { friendlyError } from '@/lib/errors';
import { AvailabilityPicker, type Slot } from './AvailabilityPicker';

const REFRESH = ['appointments', 'appointment', 'calendar', 'walkins', 'dashboard', 'customer-360', 'availability', 'my-day'];

export function useRefreshAppointments() {
  const client = useQueryClient();
  return () => {
    for (const key of REFRESH) void client.invalidateQueries({ queryKey: [key] });
  };
}

const REASONS = ['Customer called to cancel', 'Customer is unwell', 'Rescheduling for later', 'Team member unavailable', 'Other'];

interface StatusArgs {
  appointment: AppointmentDto;
  status: AppointmentStatus;
  reason?: string;
  notify?: boolean;
}

export function describe(a: AppointmentDto, tz: string): string {
  return `${a.customer.fullName} · ${a.items.map((i) => i.serviceName).join(', ')} · ${a.startAt ? `${fmtDay(a.startAt, tz)}, ${fmtTime(a.startAt, tz)}` : 'waiting'}`;
}

/** Every appointment action in one place so the calendar, lists and walk-in board behave identically. */
export function useAppointmentActions(timezone: string) {
  const refresh = useRefreshAppointments();
  const navigate = useNavigate();
  const [cancelling, setCancelling] = useState<AppointmentDto | null>(null);
  const [rescheduling, setRescheduling] = useState<AppointmentDto | null>(null);

  const status = useMutation({
    mutationFn: ({ appointment, status: to, reason, notify }: StatusArgs) => api.post<AppointmentDto>(`/appointments/${appointment.id}/status`, { status: to, version: appointment.version, reason, notifyCustomer: notify ?? true }),
    onSuccess: (updated, vars) => {
      refresh();
      const first = updated.customer.fullName.split(' ')[0];
      switch (vars.status) {
        case 'cancelled':
          toast.success(`Appointment cancelled`, { description: describe(vars.appointment, timezone), duration: 10_000, action: { label: 'Undo', onClick: () => restore(updated) } });
          break;
        case 'no_show':
          toast.success(`${first} marked as no-show`, { duration: 8000, action: { label: 'Undo', onClick: () => restore(updated) } });
          break;
        case 'checked_in':
          toast.success(`${first} checked in`);
          break;
        case 'in_service':
          toast.success(`Service started for ${first}`);
          break;
        case 'completed':
          toast.success(`Service completed for ${first}`, { action: { label: 'Create bill', onClick: () => navigate(`/billing/new?appointmentId=${updated.id}`) } });
          break;
        case 'confirmed':
          toast.success(`${first}'s booking confirmed`);
          break;
        default:
          toast.success('Appointment updated');
      }
    },
    onError: (e) => {
      refresh();
      toastError(e);
    },
  });

  const restore = (a: AppointmentDto) => status.mutate({ appointment: a, status: 'scheduled', notify: false });
  const set = (appointment: AppointmentDto, to: AppointmentStatus) => status.mutate({ appointment, status: to });

  const dialogs: ReactNode = (
    <>
      {cancelling && <CancelDialog appointment={cancelling} timezone={timezone} onClose={() => setCancelling(null)} onConfirm={(reason, notify) => { status.mutate({ appointment: cancelling, status: 'cancelled', reason, notify }); setCancelling(null); }} />}
      {rescheduling && <RescheduleDialog appointment={rescheduling} timezone={timezone} onClose={() => setRescheduling(null)} />}
    </>
  );

  return {
    busy: status.isPending,
    dialogs,
    confirm: (a: AppointmentDto) => set(a, 'confirmed'),
    checkIn: (a: AppointmentDto) => set(a, 'checked_in'),
    start: (a: AppointmentDto) => set(a, 'in_service'),
    complete: (a: AppointmentDto) => set(a, 'completed'),
    noShow: (a: AppointmentDto) => status.mutate({ appointment: a, status: 'no_show' }),
    restore,
    cancel: (a: AppointmentDto) => setCancelling(a),
    reschedule: (a: AppointmentDto) => setRescheduling(a),
    bill: (a: AppointmentDto) => navigate(`/billing/new?appointmentId=${a.id}`),
  };
}

export type AppointmentActions = ReturnType<typeof useAppointmentActions>;

/** What can be done next, in plain language; the first entry is the primary action. */
export function nextActions(a: AppointmentDto, can: (p: 'appointments.status' | 'appointments.cancel' | 'appointments.update' | 'billing.create') => boolean, actions: AppointmentActions) {
  const out: Array<{ label: string; run: () => void; primary?: boolean; tone?: 'danger'; key: string }> = [];
  const st = can('appointments.status');
  switch (a.status) {
    case 'scheduled':
      if (st) out.push({ key: 'in', label: 'Check in', run: () => actions.checkIn(a), primary: true }, { key: 'confirm', label: 'Mark confirmed', run: () => actions.confirm(a) });
      break;
    case 'confirmed':
      if (st) out.push({ key: 'in', label: 'Check in', run: () => actions.checkIn(a), primary: true });
      break;
    case 'checked_in':
      if (st) out.push({ key: 'start', label: 'Start service', run: () => actions.start(a), primary: true });
      break;
    case 'in_service':
      if (st) out.push({ key: 'done', label: 'Complete service', run: () => actions.complete(a), primary: true });
      break;
    case 'completed':
      if (!a.invoiceId && can('billing.create')) out.push({ key: 'bill', label: 'Create bill', run: () => actions.bill(a), primary: true });
      break;
    default:
      break;
  }
  if (['scheduled', 'confirmed', 'checked_in'].includes(a.status) && can('appointments.update')) out.push({ key: 'move', label: 'Reschedule', run: () => actions.reschedule(a) });
  if (['scheduled', 'confirmed', 'checked_in', 'waiting'].includes(a.status) && can('appointments.cancel')) {
    out.push({ key: 'cancel', label: 'Cancel appointment', run: () => actions.cancel(a), tone: 'danger' });
    if (a.status !== 'waiting' && a.status !== 'checked_in') out.push({ key: 'noshow', label: 'Mark as no-show', run: () => actions.noShow(a), tone: 'danger' });
  }
  if (['cancelled', 'no_show'].includes(a.status) && can('appointments.cancel')) out.push({ key: 'restore', label: 'Restore appointment', run: () => actions.restore(a) });
  return out;
}

function CancelDialog({ appointment, timezone, onClose, onConfirm }: { appointment: AppointmentDto; timezone: string; onClose: () => void; onConfirm: (reason: string, notify: boolean) => void }) {
  const [reason, setReason] = useState(REASONS[0]!);
  const [notify, setNotify] = useState(true);
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Cancel this appointment?"
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Keep appointment</Button>
          <Button variant="danger" onClick={() => onConfirm(reason, notify)}>Cancel appointment</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg bg-surface-2 p-3 text-sm">
          <p className="font-semibold text-fg">{appointment.customer.fullName}</p>
          <p className="text-muted">{appointment.items.map((i) => i.serviceName).join(', ')}</p>
          <p className="text-muted">{appointment.startAt ? `${fmtDay(appointment.startAt, timezone)}, ${fmtTime(appointment.startAt, timezone)}` : 'Waiting'}</p>
        </div>
        <Field label="Reason">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Reason">
            {REASONS.map((r) => (
              <button key={r} type="button" role="radio" aria-checked={reason === r} onClick={() => setReason(r)} className={`rounded-full border px-3 py-1.5 text-sm max-md:min-h-10 ${reason === r ? 'border-primary bg-primary-soft text-primary-soft-fg' : 'border-line hover:border-primary/50'}`}>
                {r}
              </button>
            ))}
          </div>
        </Field>
        <Switch checked={notify} onCheckedChange={setNotify} label="Tell the customer" description="This will notify the customer if notifications are enabled for them." />
      </div>
    </Modal>
  );
}

/** Move to another day/time (and optionally another team member). Only valid times are offered. */
function RescheduleDialog({ appointment, timezone, onClose }: { appointment: AppointmentDto; timezone: string; onClose: () => void }) {
  const refresh = useRefreshAppointments();
  const first = appointment.items[0]!;
  const [date, setDate] = useState(appointment.startAt ? localDate(appointment.startAt, timezone) : todayIn(timezone));
  const [slot, setSlot] = useState<Slot | null>(null);
  const [notify, setNotify] = useState(true);
  const availability = useQuery({
    queryKey: ['availability', 'reschedule', appointment.id, date],
    queryFn: () => api.get<AvailabilityResult>('/scheduling/availability', { branchId: appointment.branchId, date, serviceIds: [first.serviceId], excludeAppointmentId: appointment.id, customerId: appointment.customer.id }),
  });
  const move = useMutation({
    mutationFn: () =>
      api.put<AppointmentDto>(`/appointments/${appointment.id}`, {
        version: appointment.version,
        notifyCustomer: notify,
        // The first service takes the new time (and person); later services follow right after, with their own team members.
        items: appointment.items.map((item, i) => ({ serviceId: item.serviceId, staffId: i === 0 ? slot!.staffId : item.staffId, startAt: i === 0 ? slot!.startAt : undefined, customerPackageItemId: item.customerPackageItemId })),
      }),
    onSuccess: (a) => {
      refresh();
      toast.success(`Moved to ${fmtDay(a.startAt, timezone)}, ${fmtTime(a.startAt, timezone)}`);
      onClose();
    },
  });
  const err = move.error ? friendlyError(move.error) : null;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Reschedule"
      description={`${appointment.customer.fullName} · ${appointment.items.map((i) => i.serviceName).join(', ')}`}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Keep current time</Button>
          <Button onClick={() => move.mutate()} disabled={!slot} loading={move.isPending}>Move appointment</Button>
        </>
      }
    >
      <div className="space-y-4">
        {err && <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger"><span className="font-semibold">{err.title}. </span>{err.message}</p>}
        <p className="text-sm text-muted">Now: {appointment.startAt ? `${fmtDay(appointment.startAt, timezone)}, ${fmtTime(appointment.startAt, timezone)}` : 'not scheduled'} with <Badge tone="primary">{first.staffName ?? 'nobody yet'}</Badge></p>
        <Field label="New date" className="max-w-48">
          <DateInput value={date} min={todayIn(timezone)} onChange={(e) => { setDate(e.target.value); setSlot(null); }} />
        </Field>
        <AvailabilityPicker availability={availability.data} loading={availability.isLoading} value={slot} onChange={setSlot} timezone={timezone} preferredStaffId={first.staffId} />
        <Switch checked={notify} onCheckedChange={setNotify} label="Tell the customer about the new time" description="Reminders are rescheduled automatically." />
      </div>
    </Modal>
  );
}
