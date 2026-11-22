import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Phone, RotateCcw, Star, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router';
import { Badge, InlineNotice, Skeleton } from '@/components/ui/display';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/common/badges';
import { Modal } from '@/components/ui/overlay';
import { publicApi } from '@/lib/api';
import { friendlyError } from '@/lib/errors';
import { fmtDay, fmtDuration, fmtTime, money } from '@/lib/format';
import { PublicFrame } from './PublicFrame';
import { SlotPicker } from './SlotPicker';
import type { AppointmentStatus } from '@salon/shared';

interface Booking { bookingNumber: string; status: AppointmentStatus; startAt: string | null; endAt: string | null; branchName: string; branchPhone: string | null; salonName: string; salonCode: string; timezone: string; branchId: string; serviceIds: string[]; customerName: string; services: Array<{ name: string; staffName: string | null; startAt: string | null; durationMinutes: number; price: number }>; total: number; canChange: boolean; canMove: boolean; selfService: boolean }
interface Rebook { branchId: string; serviceIds: string[]; staffId: string | null; staffName: string | null }
interface Visit { id: string; bookingNumber: string; status: AppointmentStatus; startAt: string | null; branchId: string; branchName: string; branchPhone: string | null; timezone: string; services: Array<{ serviceId: string; name: string; staffName: string | null; durationMinutes: number }>; total: number; isThis: boolean; canChange: boolean; rebook: Rebook | null }
interface Visits { customerName: string; salonName: string; salonCode: string; currency: string; canBook: boolean; upcoming: Visit[]; past: Visit[]; usual: (Rebook & { services: string[]; branchName: string; timezone: string; times: number }) | null }
interface Booked { bookingNumber: string; startAt: string; timezone: string; confirmationSent: boolean }

/** What the cancel and move dialogs act on: the link's own booking (id null) or another of the customer's bookings. */
interface Target { id: string | null; when: string; servicesLabel: string; branchId: string; serviceIds: string[]; timezone: string }
/** "Book again": which services, where, and with whom they had them. */
interface Again { rebook: Rebook; servicesLabel: string; timezone: string }

const servicesOf = (v: Visit) => v.services.map((s) => s.name).join(', ');
const peopleOf = (v: Visit) => [...new Set(v.services.map((s) => s.staffName).filter(Boolean))].join(', ');
const whenOf = (startAt: string | null, tz: string) => (startAt ? `${fmtDay(startAt, tz, true)} at ${fmtTime(startAt, tz)}` : '');

/**
 * A customer’s private page, opened from the link in their booking message: see the booking, move it or cancel it.
 * With customer self-service, also their other visits — what is coming up, what they had before — and "Book again".
 * No account or password: the link itself is the key.
 */
export function Component() {
  const { token = '' } = useParams();
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['public', 'booking', token], queryFn: () => publicApi.get<Booking>(`/public/manage/${token}`), retry: false });
  const visits = useQuery({ queryKey: ['public', 'visits', token], queryFn: () => publicApi.get<Visits>(`/public/manage/${token}/visits`), retry: false, enabled: !!q.data?.selfService });
  const [mode, setMode] = useState<'cancel' | 'move' | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [again, setAgain] = useState<Again | null>(null);
  const [slot, setSlot] = useState<{ startAt: string; staffId: string | null } | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ['public', 'booking', token] }), client.invalidateQueries({ queryKey: ['public', 'visits', token] })]);
  const close = () => { setMode(null); setTarget(null); setAgain(null); setSlot(null); };
  const path = (id: string | null, action: string) => (id ? `/public/manage/${token}/visits/${id}/${action}` : `/public/manage/${token}/${action}`);

  const cancel = useMutation({
    mutationFn: () => publicApi.post(path(target!.id, 'cancel')),
    onSuccess: async () => { close(); setMessage({ tone: 'success', text: 'Your booking has been cancelled. We hope to see you another time.' }); await refresh(); },
    onError: (e) => { close(); setMessage({ tone: 'danger', text: friendlyError(e).message }); },
  });
  const move = useMutation({
    mutationFn: () => publicApi.post(path(target!.id, 'reschedule'), { startAt: slot!.startAt }),
    onSuccess: async () => { close(); setMessage({ tone: 'success', text: 'Done. Your booking has been moved and we have sent you a new confirmation.' }); await refresh(); },
    onError: (e) => { setMessage({ tone: 'danger', text: friendlyError(e).message }); setSlot(null); },
  });
  const book = useMutation({
    mutationFn: () => publicApi.post<Booked>(`/public/manage/${token}/book`, { branchId: again!.rebook.branchId, serviceIds: again!.rebook.serviceIds, staffId: slot!.staffId, startAt: slot!.startAt }),
    onSuccess: async (r) => {
      close();
      setMessage({ tone: 'success', text: `You are booked in for ${whenOf(r.startAt, r.timezone)}.${r.confirmationSent ? ' We have sent you a confirmation.' : ''} Booking ${r.bookingNumber}.` });
      await refresh();
    },
    onError: (e) => { setMessage({ tone: 'danger', text: friendlyError(e).message }); setSlot(null); },
  });

  if (q.isLoading) return <PublicFrame title="Your booking"><p role="status" className="py-16 text-center text-muted">Loading…</p></PublicFrame>;
  if (q.isError || !q.data) {
    const expired = /expired/i.test(q.error ? friendlyError(q.error).message : '');
    return (
      <PublicFrame title="Your booking">
        <div className="rounded-2xl border border-line bg-surface p-8 text-center">
          <h2 className="text-lg font-semibold">{expired ? 'This link has expired' : 'We could not find this booking'}</h2>
          <p className="mt-2 text-muted">{expired ? 'Please use the link in your latest message from the salon, or call them.' : 'The link may be incomplete. Please use the link from your confirmation message, or call the salon.'}</p>
        </div>
      </PublicFrame>
    );
  }
  const b = q.data;
  const active = ['scheduled', 'confirmed'].includes(b.status);
  const v = visits.data;
  const others = v?.upcoming.filter((u) => !u.isThis) ?? [];
  const openThis = (m: 'cancel' | 'move') => { setMessage(null); setMode(m); setTarget({ id: null, when: whenOf(b.startAt, b.timezone), servicesLabel: b.services.map((s) => s.name).join(', '), branchId: b.branchId, serviceIds: b.serviceIds, timezone: b.timezone }); };
  const openOther = (m: 'cancel' | 'move', u: Visit) => { setMessage(null); setMode(m); setTarget({ id: u.id, when: whenOf(u.startAt, u.timezone), servicesLabel: servicesOf(u), branchId: u.branchId, serviceIds: u.services.map((s) => s.serviceId), timezone: u.timezone }); };
  const openAgain = (rebook: Rebook, servicesLabel: string, timezone: string) => { setMessage(null); setSlot(null); setAgain({ rebook, servicesLabel, timezone }); };

  return (
    <PublicFrame title={b.salonName} subtitle={`Booking ${b.bookingNumber}`}>
      <div className="space-y-4">
        {message && <InlineNotice tone={message.tone}>{message.text}</InlineNotice>}
        <div className="rounded-2xl border border-line bg-surface p-5 shadow-card">
          <div className="flex flex-wrap items-center gap-2"><StatusBadge status={b.status} />{b.status === 'cancelled' && <Badge>No longer active</Badge>}</div>
          {b.startAt && <p className="mt-3 text-lg font-semibold">{whenOf(b.startAt, b.timezone)}</p>}
          <p className="text-sm text-muted">{b.branchName} · for {b.customerName}</p>
          <ul className="mt-4 divide-y divide-line text-sm">{b.services.map((s, i) => <li key={i} className="flex justify-between gap-3 py-2"><span>{s.name}{s.staffName ? <span className="text-muted"> with {s.staffName}</span> : null}</span><span className="text-muted">{fmtDuration(s.durationMinutes)}</span></li>)}</ul>
          <p className="mt-2 flex justify-between border-t border-line pt-3 font-semibold"><span>Estimated total</span><span>{money(b.total)}</span></p>
        </div>
        {active && b.canChange && (
          <div className="flex flex-wrap gap-2">
            {b.canMove && <Button size="lg" icon={<CalendarClock className="size-4" />} onClick={() => openThis('move')}>Change time</Button>}
            <Button size="lg" variant="outline" icon={<XCircle className="size-4" />} onClick={() => openThis('cancel')}>Cancel booking</Button>
          </div>
        )}
        {active && !b.canChange && <InlineNotice tone="info">It is too close to your appointment to change it online. Please call the salon{b.branchPhone ? ` on ${b.branchPhone}` : ''}.</InlineNotice>}
        {active && b.canChange && !b.canMove && <p className="text-sm text-muted">To change the time, please call the salon{b.branchPhone ? ` on ${b.branchPhone}` : ''}.</p>}
        {b.branchPhone && <p className="flex items-center gap-2 text-sm text-muted"><Phone className="size-4" aria-hidden />{b.branchName}: {b.branchPhone}</p>}
      </div>

      {b.selfService && (
        <section aria-labelledby="visits-heading" className="mt-8 space-y-5">
          <h2 id="visits-heading" className="text-lg font-semibold">Your visits</h2>
          {visits.isLoading && <div role="status" aria-label="Loading your visits" className="space-y-2"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>}
          {visits.isError && <InlineNotice tone="danger">We could not load your other visits just now. Please try again later.</InlineNotice>}
          {v && (
            <>
              {v.usual && v.canBook && (
                <div className="flex flex-col gap-3 rounded-2xl border border-primary/40 bg-primary-soft p-4 sm:flex-row sm:items-center">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-full bg-surface text-primary"><Star className="size-5" aria-hidden /></span>
                    <div className="min-w-0">
                      <p className="font-semibold">Your usual</p>
                      <p className="text-sm text-muted">{v.usual.services.join(', ')}{v.usual.staffName ? ` with ${v.usual.staffName}` : ''} · {v.usual.branchName} · {v.usual.times} visits</p>
                    </div>
                  </div>
                  <Button size="lg" className="max-sm:w-full" icon={<RotateCcw className="size-4" />} onClick={() => openAgain(v.usual!, v.usual!.services.join(', '), v.usual!.timezone)}>Book your usual</Button>
                </div>
              )}

              <div>
                <h3 className="mb-2 text-sm font-semibold text-muted">Coming up</h3>
                {others.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">{v.upcoming.some((u) => u.isThis) ? 'Nothing else is booked.' : 'Nothing is booked.'}</p>
                ) : (
                  <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
                    {others.map((u) => (
                      <li key={u.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">{whenOf(u.startAt, u.timezone)}</p>
                          <p className="text-sm text-muted">{servicesOf(u)}{peopleOf(u) ? ` with ${peopleOf(u)}` : ''} · {u.branchName}</p>
                        </div>
                        {u.canChange ? (
                          <div className="flex gap-2">
                            {v.canBook && <Button variant="outline" onClick={() => openOther('move', u)} aria-label={`Change time of ${whenOf(u.startAt, u.timezone)}`}>Change time</Button>}
                            <Button variant="ghost" onClick={() => openOther('cancel', u)} aria-label={`Cancel ${whenOf(u.startAt, u.timezone)}`}>Cancel</Button>
                          </div>
                        ) : <StatusBadge status={u.status} />}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <h3 className="mb-2 text-sm font-semibold text-muted">Before</h3>
                {v.past.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">Your earlier visits will show here.</p>
                ) : (
                  <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
                    {v.past.map((p) => (
                      <li key={p.id} className="flex flex-wrap items-center gap-3 p-4">
                        <div className="min-w-0 flex-1">
                          <p className="flex flex-wrap items-center gap-2 font-medium">{p.startAt ? fmtDay(p.startAt, p.timezone, true) : p.bookingNumber}{p.status !== 'completed' && <StatusBadge status={p.status} />}</p>
                          <p className="text-sm text-muted">{servicesOf(p)}{peopleOf(p) ? ` with ${peopleOf(p)}` : ''} · {p.branchName}</p>
                        </div>
                        {v.canBook && p.rebook && <Button variant="outline" icon={<RotateCcw className="size-4" />} onClick={() => openAgain(p.rebook!, servicesOf(p), p.timezone)} aria-label={`Book again: ${servicesOf(p)}`}>Book again</Button>}
                      </li>
                    ))}
                  </ul>
                )}
                {!v.canBook && v.past.length > 0 && <p className="mt-2 text-sm text-muted">To book again, please call the salon{b.branchPhone ? ` on ${b.branchPhone}` : ''}.</p>}
              </div>
            </>
          )}
        </section>
      )}

      {mode === 'cancel' && target && (
        <Modal open onOpenChange={(o) => !o && close()} title="Cancel this booking?" description={target.when || undefined} size="sm" footer={<><Button variant="outline" onClick={close}>Keep my booking</Button><Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>Yes, cancel it</Button></>}>
          <p className="text-sm text-muted">{target.servicesLabel}. The time will be released for someone else. You can always book again.</p>
        </Modal>
      )}
      {mode === 'move' && target && (
        <Modal open onOpenChange={(o) => !o && close()} title="Choose a new time" description={target.servicesLabel} footer={<><Button variant="outline" onClick={close}>Keep current time</Button><Button loading={move.isPending} disabled={!slot} onClick={() => move.mutate()}>Move my booking</Button></>}>
          <SlotPicker code={b.salonCode} branchId={target.branchId} serviceIds={target.serviceIds} timezone={target.timezone} value={slot} onChange={setSlot} />
        </Modal>
      )}
      {again && (
        <Modal open onOpenChange={(o) => !o && close()} title="Book again" description={`${again.servicesLabel}${again.rebook.staffName ? ` · with ${again.rebook.staffName} if they are free` : ''}`} footer={<><Button variant="outline" onClick={close}>Not now</Button><Button loading={book.isPending} disabled={!slot} onClick={() => book.mutate()}>Book this time</Button></>}>
          <SlotPicker code={b.salonCode} branchId={again.rebook.branchId} serviceIds={again.rebook.serviceIds} timezone={again.timezone} value={slot} onChange={setSlot} prefer={again.rebook.staffId ? { staffId: again.rebook.staffId, name: again.rebook.staffName } : null} />
        </Modal>
      )}
    </PublicFrame>
  );
}
