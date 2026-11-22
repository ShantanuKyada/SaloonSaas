import { WALK_IN_STAGES, WALK_IN_STAGE_LABELS, type AppointmentDto, type SalonNow, type WalkInStage } from '@salon/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, DoorOpen, Receipt, UserCheck } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { toastError } from '@/app/providers';
import { PendingChip } from '@/components/common/badges';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, ErrorState, PageHeader } from '@/components/ui/display';
import { Field, Select, Switch } from '@/components/ui/form';
import { Modal } from '@/components/ui/overlay';
import { AppointmentDrawer } from '@/features/appointments/AppointmentDrawer';
import { useAppointmentActions } from '@/features/appointments/actions';
import { useQuickActions } from '@/features/quick/QuickActions';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { fmtDay, fmtTime, localDate, todayIn } from '@/lib/format';
import { friendlyError } from '@/lib/errors';
import { useNow } from '@/lib/hooks';

export function Component() {
  const { branchId, branch, timezone } = useBranch();
  const can = useCan();
  const quick = useQuickActions();
  const now = useNow(20_000);
  const actions = useAppointmentActions(timezone);
  const [openId, setOpenId] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<AppointmentDto | null>(null);
  const board = useQuery({ queryKey: ['walkins', branchId], queryFn: () => api.get<AppointmentDto[]>('/walkins', { branchId }), refetchInterval: 15_000, enabled: !!branchId });

  const columns = WALK_IN_STAGES.map((stage) => ({ stage, items: (board.data ?? []).filter((a) => a.walkInStage === stage) }));
  const waiting = columns[0]!.items.length;

  return (
    <div>
      <PageHeader title="Walk-ins" description={`${branch.name} · ${waiting} waiting now`} actions={can('walkins.manage') && <Button icon={<DoorOpen className="size-4" />} hotkey="W" onClick={() => quick.walkIn()}>Add walk-in</Button>} />
      {board.isError && <ErrorState error={board.error} onRetry={() => void board.refetch()} />}
      {board.isLoading && <div role="status" aria-label="Loading walk-ins" className="skeleton h-64" />}
      {board.data && board.data.length === 0 && (
        <EmptyState icon={<DoorOpen className="size-6" />} title="No walk-ins today" description="When a customer walks in, add them here to keep the queue fair and track their service from start to bill." action={can('walkins.manage') && <Button onClick={() => quick.walkIn()}>Add walk-in</Button>} />
      )}
      {board.data && board.data.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          {columns.map(({ stage, items }) => (
            <section key={stage} aria-label={WALK_IN_STAGE_LABELS[stage]} className="rounded-xl bg-surface-2 p-2">
              <h2 className="mb-2 flex items-center justify-between px-1 text-sm font-semibold">
                {WALK_IN_STAGE_LABELS[stage]}
                <Badge tone={stage === 'waiting' && items.length ? 'warning' : 'neutral'}>{items.length}</Badge>
              </h2>
              <ul className="space-y-2">
                {items.map((a) => (
                  <li key={a.id}>
                    <WalkInCard a={a} stage={stage} now={now} tz={timezone} onOpen={() => setOpenId(a.id)} onAssign={() => setAssigning(a)} actions={actions} canManage={can('walkins.manage')} canBill={can('billing.create')} />
                  </li>
                ))}
                {items.length === 0 && <li className="px-2 py-4 text-center text-xs text-faint">Empty</li>}
              </ul>
            </section>
          ))}
        </div>
      )}
      {openId && <AppointmentDrawer id={openId} onClose={() => setOpenId(null)} />}
      {assigning && <AssignDialog appointment={assigning} onClose={() => setAssigning(null)} />}
      {actions.dialogs}
    </div>
  );
}

function WalkInCard({ a, stage, now, tz, onOpen, onAssign, actions, canManage, canBill }: { a: AppointmentDto; stage: WalkInStage; now: number; tz: string; onOpen: () => void; onAssign: () => void; actions: ReturnType<typeof useAppointmentActions>; canManage: boolean; canBill: boolean }) {
  const waitedMin = a.arrivedAt ? Math.max(0, Math.round((now - new Date(a.arrivedAt).getTime()) / 60_000)) : 0;
  // Someone still "waiting" from an earlier day most likely left: say since when, so the desk can close them.
  const earlierDay = !!a.arrivedAt && localDate(a.arrivedAt, tz) < todayIn(tz);
  const waited = earlierDay ? `since ${fmtDay(a.arrivedAt!, tz)}` : waitedMin < 60 ? `${waitedMin} min` : `${Math.floor(waitedMin / 60)} h ${waitedMin % 60} min`;
  return (
    <div className="rounded-xl border border-line bg-surface p-3 shadow-card">
      <button type="button" onClick={onOpen} className="block w-full text-left">
        <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
          <p className="min-w-0 font-semibold text-fg"><span className="mr-1.5 text-muted">#{a.queueNumber}</span>{a.customer.fullName}</p>
          {stage === 'waiting' && <Badge tone={waitedMin > 20 ? 'danger' : 'warning'}><Clock className="size-3" aria-hidden /> {waited}</Badge>}
        </div>
        <p className="mt-0.5 text-sm text-muted">{a.items.map((i) => i.serviceName).join(', ')}</p>
        {a.items.some((i) => i.staffName) && <p className="text-xs text-muted">{[...new Set(a.items.map((i) => i.staffName).filter(Boolean))].join(', ')}{a.startAt ? ` · ${fmtTime(a.startAt, tz)}` : ''}</p>}
        <div className="mt-1.5"><PendingChip amount={a.customer.outstanding} /></div>
        {earlierDay && stage === 'waiting' && <p className="mt-1.5 text-xs text-muted">From an earlier day. Assign them, or remove them if they left.</p>}
      </button>
      {canManage && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {stage === 'waiting' && <Button size="sm" icon={<UserCheck className="size-4" />} onClick={onAssign} title="Assign a team member">Assign</Button>}
          {stage === 'assigned' && <Button size="sm" onClick={() => actions.start(a)}>Start service</Button>}
          {stage === 'in_service' && <Button size="sm" onClick={() => actions.complete(a)}>Complete</Button>}
          {stage === 'completed' && canBill && <Button size="sm" icon={<Receipt className="size-4" />} onClick={() => actions.bill(a)}>Create bill</Button>}
          {(stage === 'waiting' || stage === 'assigned') && <Button size="sm" variant="ghost" onClick={() => actions.cancel(a)}>Remove</Button>}
        </div>
      )}
    </div>
  );
}

function AssignDialog({ appointment, onClose }: { appointment: AppointmentDto; onClose: () => void }) {
  const client = useQueryClient();
  const { branchId } = useBranch();
  const [staffByItem, setStaffByItem] = useState<Record<string, string>>(Object.fromEntries(appointment.items.filter((i) => i.staffId).map((i) => [i.id, i.staffId!])));
  const [startNow, setStartNow] = useState(true);
  const live = useQuery({ queryKey: ['dashboard', 'now', branchId], queryFn: () => api.get<SalonNow & { branchId: string }>('/dashboard/now', { branchId }), refetchInterval: 15_000 });
  const qualified = useQuery({
    queryKey: ['walkin-qualified', branchId, appointment.id],
    queryFn: async () => Object.fromEntries(await Promise.all(appointment.items.map(async (i) => [i.id, (await api.list<{ id: string; displayName: string }>('/staff', { branchId, serviceId: i.serviceId, bookableOnly: 'true', pageSize: 100 })).rows] as const))),
  });
  const assign = useMutation({
    mutationFn: () => api.post<AppointmentDto>(`/walkins/${appointment.id}/assign`, { version: appointment.version, startNow, assignments: appointment.items.map((i) => ({ itemId: i.id, staffId: staffByItem[i.id] })) }),
    onSuccess: (a) => {
      for (const key of ['walkins', 'appointments', 'calendar', 'dashboard']) void client.invalidateQueries({ queryKey: [key] });
      toast.success(startNow ? `Service started for ${a.customer.fullName.split(' ')[0]}` : `${a.customer.fullName.split(' ')[0]} is booked for the next free time`);
      onClose();
    },
    onError: toastError,
  });
  const ready = appointment.items.every((i) => staffByItem[i.id]);
  const err = assign.error ? friendlyError(assign.error) : null;
  // Starting now needs the person free for the whole service: name anyone whose day (or next booking) comes first.
  const minutesFor = (staffId: string) => appointment.items.filter((i) => staffByItem[i.id] === staffId).reduce((a, i) => a + i.durationMinutes, 0);
  const tooShort = (staffId: string, minutes: number) => {
    const until = live.data?.staff.find((x) => x.staffId === staffId)?.freeUntil;
    return !!until && Date.now() + minutes * 60_000 > new Date(until).getTime();
  };
  const cannotStart = startNow ? [...new Set(Object.values(staffByItem))].filter((id) => id && tooShort(id, minutesFor(id))) : [];
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Assign team member · ${appointment.customer.fullName}`} size="md" footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!ready} loading={assign.isPending} onClick={() => assign.mutate()}>{startNow ? 'Start now' : 'Book next free time'}</Button></>}>
      <div className="space-y-4">
        {err && <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{err.message}</p>}
        {appointment.items.map((i) => (
          <Field key={i.id} label={i.serviceName}>
            <Select value={staffByItem[i.id] ?? ''} onChange={(e) => setStaffByItem((m) => ({ ...m, [i.id]: e.target.value }))}>
              <option value="">Choose a team member</option>
              {(qualified.data?.[i.id] ?? []).map((s) => {
                const st = live.data?.staff.find((x) => x.staffId === s.id);
                const short = startNow && st?.state === 'available' && tooShort(s.id, i.durationMinutes);
                return <option key={s.id} value={s.id}>{s.displayName}{st ? ` — ${st.label}` : ''}{short ? ' (not enough time now)' : ''}</option>;
              })}
            </Select>
          </Field>
        ))}
        <Switch checked={startNow} onCheckedChange={setStartNow} label="Start right now" description={startNow ? 'The service starts immediately.' : 'They will be booked at the team member’s next free time today.'} />
        {cannotStart.length > 0 && (
          <p role="status" className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
            {cannotStart.map((id) => { const st = live.data?.staff.find((x) => x.staffId === id); return `${st?.displayName ?? 'This team member'} is ${st?.label.toLowerCase() ?? 'not free long enough'}`; }).join('; ')}, which is not long enough for {minutesFor(cannotStart[0]!)} minutes. Choose someone else, or turn off “Start right now” to book the next free time.
          </p>
        )}
      </div>
    </Modal>
  );
}
