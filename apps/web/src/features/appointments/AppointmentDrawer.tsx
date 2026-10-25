import type { AppointmentEventDto } from '@salon/shared';
import { APPOINTMENT_SOURCE_LABELS } from '@salon/shared';
import { useQuery } from '@tanstack/react-query';
import { Clock, Package, Phone, Receipt } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Money, PaymentBadge, PendingChip, StatusBadge } from '@/components/common/badges';
import { Button } from '@/components/ui/button';
import { Avatar, Badge, ErrorState, InlineNotice, Skeleton } from '@/components/ui/display';
import { Drawer, Menu } from '@/components/ui/overlay';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { fmtDateTime, fmtDay, fmtDuration, fmtTime } from '@/lib/format';
import { useAppointment } from '@/lib/queries';
import { nextActions, useAppointmentActions } from './actions';

const EVENT_LABEL: Record<string, string> = { created: 'Booked', status_changed: 'Status changed', rescheduled: 'Moved to a new time', staff_changed: 'Team member changed', services_changed: 'Services changed', restored: 'Restored', billed: 'Billing', note: 'Note' };

export function AppointmentDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { timezone } = useBranch();
  const can = useCan();
  const q = useAppointment(id);
  const actions = useAppointmentActions(timezone);
  const [showHistory, setShowHistory] = useState(false);
  const events = useQuery({ queryKey: ['appointment', id, 'events'], queryFn: () => api.get<AppointmentEventDto[]>(`/appointments/${id}/events`), enabled: showHistory });
  const a = q.data;
  const list = a ? nextActions(a, (p) => can(p), actions) : [];
  const primary = list.find((x) => x.primary);
  const secondary = list.filter((x) => !x.primary);

  return (
    <>
      <Drawer
        open
        onOpenChange={(o) => !o && onClose()}
        title={a ? `Booking ${a.bookingNumber}` : 'Appointment'}
        description={a ? `${APPOINTMENT_SOURCE_LABELS[a.source]}${a.queueNumber ? ` · Queue #${a.queueNumber}` : ''} · ${a.branchName}` : undefined}
        footer={
          a && (primary || secondary.length > 0) ? (
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <Menu align="start" label="More actions" trigger={<Button variant="outline">More actions</Button>} items={secondary.map((s) => ({ label: s.label, onSelect: s.run, tone: s.tone }))} />
              {primary && (
                <Button onClick={primary.run} loading={actions.busy} icon={primary.key === 'bill' ? <Receipt className="size-4" /> : undefined}>
                  {primary.label}
                </Button>
              )}
            </div>
          ) : undefined
        }
      >
        {q.isLoading && <div className="space-y-3"><Skeleton className="h-16" /><Skeleton className="h-32" /></div>}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} compact />}
        {a && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={a.status} />
              {a.paymentStatus && <PaymentBadge status={a.paymentStatus} />}
              {a.rescheduleCount > 0 && <Badge tone="neutral">Rescheduled {a.rescheduleCount}×</Badge>}
            </div>

            <div className="flex items-start gap-3 rounded-xl border border-line p-3">
              <Avatar name={a.customer.fullName} />
              <div className="min-w-0 flex-1">
                <Link to={`/customers/${a.customer.id}`} onClick={onClose} className="font-semibold text-fg hover:underline">{a.customer.fullName}</Link>
                <p className="flex flex-wrap items-center gap-x-3 text-xs text-muted">
                  <span>{a.customer.customerCode}</span>
                  {a.customer.mobile && <span className="inline-flex items-center gap-1"><Phone className="size-3" aria-hidden />{a.customer.mobile}</span>}
                </p>
              </div>
              <PendingChip amount={a.customer.outstanding} />
            </div>

            <div>
              <p className="mb-2 flex items-center gap-2 text-sm font-semibold"><Clock className="size-4 text-muted" aria-hidden />{a.startAt ? `${fmtDay(a.startAt, timezone, true)}, ${fmtTime(a.startAt, timezone)}–${fmtTime(a.endAt, timezone)}` : 'Waiting for a team member'}</p>
              <ul className="divide-y divide-line rounded-xl border border-line">
                {a.items.map((i) => (
                  <li key={i.id} className="flex items-center gap-3 px-3 py-2.5">
                    <span className="h-9 w-1 rounded-full" style={{ background: i.staffColor ?? i.categoryColor }} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-fg">{i.serviceName}</p>
                      <p className="text-xs text-muted">{i.staffName ?? 'No team member yet'}{i.startAt ? ` · ${fmtTime(i.startAt, timezone)}` : ''} · {fmtDuration(i.durationMinutes)}</p>
                    </div>
                    {i.customerPackageItemId ? <Badge tone="success"><Package className="size-3" aria-hidden /> Package</Badge> : <Money value={i.price} className="text-sm" />}
                  </li>
                ))}
              </ul>
              <p className="mt-2 flex justify-between text-sm"><span className="text-muted">Estimated total</span><Money value={a.estimatedAmount} className="font-semibold" /></p>
            </div>

            {a.invoiceNumber && (
              <InlineNotice tone="success" title={`Billed: ${a.invoiceNumber}`} action={a.invoiceId ? <Link to={`/billing/bills/${a.invoiceId}`} onClick={onClose} className="text-sm font-medium underline">View bill</Link> : undefined} />
            )}
            {a.notes && (
              <div>
                <p className="text-xs font-medium text-muted">Notes</p>
                <p className="mt-0.5 whitespace-pre-wrap text-sm">{a.notes}</p>
              </div>
            )}
            {a.internalNotes && can('appointments.view') && (
              <div>
                <p className="text-xs font-medium text-muted">Internal remarks</p>
                <p className="mt-0.5 whitespace-pre-wrap text-sm">{a.internalNotes}</p>
              </div>
            )}
            {a.cancellationReason && ['cancelled', 'no_show'].includes(a.status) && <InlineNotice tone="warning" title="Why">{a.cancellationReason}</InlineNotice>}

            <div>
              <button type="button" onClick={() => setShowHistory((s) => !s)} className="text-sm font-medium text-primary hover:underline">{showHistory ? 'Hide history' : 'Show history'}</button>
              {showHistory && (
                <ol className="mt-3 space-y-3 border-l border-line pl-4">
                  {events.isLoading && <Skeleton className="h-10" />}
                  {events.data?.map((e) => (
                    <li key={e.id} className="relative text-sm">
                      <span className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-primary" aria-hidden />
                      <p className="font-medium text-fg">{EVENT_LABEL[e.eventType] ?? e.eventType}{e.toStatus ? `: ${e.toStatus.replace('_', ' ')}` : ''}</p>
                      <p className="text-xs text-muted">{fmtDateTime(e.createdAt, timezone)}{e.actorName ? ` · ${e.actorName}` : ''}</p>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        )}
      </Drawer>
      {actions.dialogs}
    </>
  );
}
