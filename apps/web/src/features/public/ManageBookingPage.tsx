import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Phone, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router';
import { Badge, InlineNotice } from '@/components/ui/display';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/common/badges';
import { Modal } from '@/components/ui/overlay';
import { publicApi } from '@/lib/api';
import { friendlyError } from '@/lib/errors';
import { fmtDay, fmtDuration, fmtTime, money } from '@/lib/format';
import { PublicFrame } from './PublicFrame';
import { SlotPicker } from './SlotPicker';
import type { AppointmentStatus } from '@salon/shared';

interface Booking { bookingNumber: string; status: AppointmentStatus; startAt: string | null; endAt: string | null; branchName: string; branchPhone: string | null; salonName: string; salonCode: string; timezone: string; branchId: string; serviceIds: string[]; customerName: string; services: Array<{ name: string; staffName: string | null; startAt: string | null; durationMinutes: number; price: number }>; total: number; canChange: boolean }

/** A customer’s private booking page: see it, move it or cancel it. No account needed. */
export function Component() {
  const { token = '' } = useParams();
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['public', 'booking', token], queryFn: () => publicApi.get<Booking>(`/public/manage/${token}`), retry: false });
  const [mode, setMode] = useState<'cancel' | 'move' | null>(null);
  const [slot, setSlot] = useState<{ startAt: string; staffId: string | null } | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ['public', 'booking', token] });
  const cancel = useMutation({
    mutationFn: () => publicApi.post(`/public/manage/${token}/cancel`),
    onSuccess: async () => { setMode(null); setMessage({ tone: 'success', text: 'Your booking has been cancelled. We hope to see you another time.' }); await refresh(); },
    onError: (e) => { setMode(null); setMessage({ tone: 'danger', text: friendlyError(e).message }); },
  });
  const move = useMutation({
    mutationFn: () => publicApi.post(`/public/manage/${token}/reschedule`, { startAt: slot!.startAt }),
    onSuccess: async () => { setMode(null); setSlot(null); setMessage({ tone: 'success', text: 'Done. Your booking has been moved and we have sent you a new confirmation.' }); await refresh(); },
    onError: (e) => { setMessage({ tone: 'danger', text: friendlyError(e).message }); setSlot(null); },
  });

  if (q.isLoading) return <PublicFrame title="Your booking"><p role="status" className="py-16 text-center text-muted">Loading…</p></PublicFrame>;
  if (q.isError || !q.data) return <PublicFrame title="Your booking"><div className="rounded-2xl border border-line bg-surface p-8 text-center"><h2 className="text-lg font-semibold">We could not find this booking</h2><p className="mt-2 text-muted">The link may be incomplete. Please use the link from your confirmation message, or call the salon.</p></div></PublicFrame>;
  const b = q.data;
  const active = ['scheduled', 'confirmed'].includes(b.status);

  return (
    <PublicFrame title={b.salonName} subtitle={`Booking ${b.bookingNumber}`}>
      <div className="space-y-4">
        {message && <InlineNotice tone={message.tone}>{message.text}</InlineNotice>}
        <div className="rounded-2xl border border-line bg-surface p-5 shadow-card">
          <div className="flex flex-wrap items-center gap-2"><StatusBadge status={b.status} />{b.status === 'cancelled' && <Badge>No longer active</Badge>}</div>
          {b.startAt && <p className="mt-3 text-lg font-semibold">{fmtDay(b.startAt, b.timezone, true)} at {fmtTime(b.startAt, b.timezone)}</p>}
          <p className="text-sm text-muted">{b.branchName} · for {b.customerName}</p>
          <ul className="mt-4 divide-y divide-line text-sm">{b.services.map((s, i) => <li key={i} className="flex justify-between gap-3 py-2"><span>{s.name}{s.staffName ? <span className="text-muted"> with {s.staffName}</span> : null}</span><span className="text-muted">{fmtDuration(s.durationMinutes)}</span></li>)}</ul>
          <p className="mt-2 flex justify-between border-t border-line pt-3 font-semibold"><span>Estimated total</span><span>{money(b.total)}</span></p>
        </div>
        {active && b.canChange && (
          <div className="flex flex-wrap gap-2">
            <Button size="lg" icon={<CalendarClock className="size-4" />} onClick={() => { setMessage(null); setMode('move'); }}>Change time</Button>
            <Button size="lg" variant="outline" icon={<XCircle className="size-4" />} onClick={() => { setMessage(null); setMode('cancel'); }}>Cancel booking</Button>
          </div>
        )}
        {active && !b.canChange && <InlineNotice tone="info">It is too close to your appointment to change it online. Please call the salon{b.branchPhone ? ` on ${b.branchPhone}` : ''}.</InlineNotice>}
        {b.branchPhone && <p className="flex items-center gap-2 text-sm text-muted"><Phone className="size-4" aria-hidden />{b.branchName}: {b.branchPhone}</p>}
      </div>

      {mode === 'cancel' && (
        <Modal open onOpenChange={(o) => !o && setMode(null)} title="Cancel this booking?" description={b.startAt ? `${fmtDay(b.startAt, b.timezone, true)} at ${fmtTime(b.startAt, b.timezone)}` : undefined} size="sm" footer={<><Button variant="outline" onClick={() => setMode(null)}>Keep my booking</Button><Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>Yes, cancel it</Button></>}>
          <p className="text-sm text-muted">The time will be released for someone else. You can always book again.</p>
        </Modal>
      )}
      {mode === 'move' && (
        <Modal open onOpenChange={(o) => !o && setMode(null)} title="Choose a new time" description={b.services.map((s) => s.name).join(', ')} footer={<><Button variant="outline" onClick={() => setMode(null)}>Keep current time</Button><Button loading={move.isPending} disabled={!slot} onClick={() => move.mutate()}>Move my booking</Button></>}>
          <SlotPicker code={b.salonCode} branchId={b.branchId} serviceIds={b.serviceIds} timezone={b.timezone} value={slot} onChange={setSlot} />
        </Modal>
      )}
    </PublicFrame>
  );
}
