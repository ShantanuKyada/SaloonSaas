import { useQuery } from '@tanstack/react-query';
import { Phone } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toastError } from '@/app/providers';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, ErrorState, Skeleton } from '@/components/ui/display';
import { StatusBadge } from '@/components/common/badges';
import { api } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { fmtDuration, fmtTime, greeting } from '@/lib/format';
import { useMoney } from '@/components/common/badges';
import type { AppointmentStatus } from '@salon/shared';

interface Item {
  itemId: string;
  appointmentId: string;
  bookingNumber: string;
  status: AppointmentStatus;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  service: string;
  serviceDescription: string | null;
  customerName: string;
  customerMobile: string | null;
  notes: string | null;
}
interface MyDay {
  date: string;
  timezone: string;
  staff: { id: string; displayName: string; branchName: string };
  summary: { total: number; completed: number; remaining: number; cancelled: number; tomorrow: number };
  current: Item | null;
  next: Item | null;
  schedule: Item[];
  performance: { completedThisMonth: number; revenueThisMonth: number } | null;
}

/** The team member's phone-first home: today's list, the one in progress, and the next one. Nothing else. */
export function Component() {
  const user = useUser();
  const money = useMoney();
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['my-day'], queryFn: () => api.get<MyDay>('/dashboard/my-day'), refetchInterval: 30_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const status = useMutation({
    mutationFn: ({ id, to }: { id: string; to: 'in_service' | 'completed' }) => api.post(`/appointments/${id}/status`, { status: to, notifyCustomer: false }),
    onMutate: ({ id }) => setBusy(id),
    onSuccess: (_d, v) => { toast.success(v.to === 'in_service' ? 'Service started' : 'Service completed'); },
    onError: toastError,
    onSettled: () => { setBusy(null); void client.invalidateQueries({ queryKey: ['my-day'] }); },
  });

  if (q.isLoading) return <div role="status" aria-label="Loading your day" className="mx-auto max-w-xl space-y-3"><Skeleton className="h-16" /><Skeleton className="h-40" /><Skeleton className="h-24" /></div>;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data;
  const tz = d.timezone;
  const act = (i: Item) => (i.status === 'in_service' ? { label: 'Complete service', to: 'completed' as const } : ['scheduled', 'confirmed', 'checked_in'].includes(i.status) ? { label: 'Start service', to: 'in_service' as const } : null);

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{greeting(tz)}, {user.fullName.split(' ')[0]}</h1>
        <p className="text-sm text-muted">Today’s appointments: <span className="font-semibold text-fg">{d.summary.total}</span> · {d.summary.completed} done · {d.summary.remaining} to go{d.summary.cancelled > 0 ? ` · ${d.summary.cancelled} cancelled` : ''}</p>
      </div>

      {d.current && (
        <Card className="border-success/40 bg-success-soft/40">
          <p className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-success"><span className="pulse-dot size-2 rounded-full bg-success" />Now</p>
          <p className="text-xl font-semibold">{d.current.customerName}</p>
          <p className="text-muted">{d.current.service} · until {fmtTime(d.current.endAt, tz)}</p>
          {d.current.notes && <p className="mt-2 rounded-lg bg-surface p-2 text-sm">{d.current.notes}</p>}
          {act(d.current) && <Button size="lg" className="mt-3 w-full" loading={busy === d.current.appointmentId} onClick={() => status.mutate({ id: d.current!.appointmentId, to: act(d.current!)!.to })}>{act(d.current)!.label}</Button>}
        </Card>
      )}
      {d.next && (
        <Card>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Next up · {fmtTime(d.next.startAt, tz)}</p>
          <p className="text-lg font-semibold">{d.next.customerName}</p>
          <p className="text-muted">{d.next.service} · {fmtDuration(d.next.durationMinutes)}</p>
          {d.next.notes && <p className="mt-2 rounded-lg bg-surface-2 p-2 text-sm">{d.next.notes}</p>}
          {!d.current && act(d.next) && <Button size="lg" variant="soft" className="mt-3 w-full" loading={busy === d.next.appointmentId} onClick={() => status.mutate({ id: d.next!.appointmentId, to: act(d.next!)!.to })}>{act(d.next)!.label}</Button>}
        </Card>
      )}

      <section aria-label="Today's schedule">
        <h2 className="mb-2 text-sm font-semibold">Today</h2>
        {d.schedule.length === 0 ? <Card><EmptyState title="No appointments today" description={d.summary.tomorrow > 0 ? `You have ${d.summary.tomorrow} tomorrow.` : 'Enjoy the quiet day.'} /></Card> : (
          <ol className="space-y-2">
            {d.schedule.map((i) => (
              <li key={i.itemId} className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3 shadow-card">
                <div className="w-16 shrink-0 text-center"><p className="text-base font-semibold tabular-nums">{fmtTime(i.startAt, tz).replace(' ', ' ')}</p><p className="text-[11px] text-muted">{fmtDuration(i.durationMinutes)}</p></div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{i.customerName}</p>
                  <p className="truncate text-sm text-muted">{i.service}</p>
                  {i.customerMobile && <p className="flex items-center gap-1 text-xs text-faint"><Phone className="size-3" aria-hidden />{i.customerMobile}</p>}
                </div>
                <StatusBadge status={i.status} />
              </li>
            ))}
          </ol>
        )}
      </section>
      {d.performance && (
        <Card><p className="text-xs font-semibold uppercase tracking-wide text-muted">This month</p><p className="mt-1 text-sm"><Badge tone="success">{d.performance.completedThisMonth} appointments done</Badge> <span className="ml-2 text-muted">Services worth {money(d.performance.revenueThisMonth)}</span></p></Card>
      )}
      {d.summary.tomorrow > 0 && <p className="text-center text-sm text-muted">Tomorrow: {d.summary.tomorrow} {d.summary.tomorrow === 1 ? 'appointment' : 'appointments'}</p>}
    </div>
  );
}
