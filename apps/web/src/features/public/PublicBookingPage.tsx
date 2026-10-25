import { useMutation, useQuery } from '@tanstack/react-query';
import { CalendarCheck, Check, ChevronLeft, Copy, MapPin, Phone, Scissors } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, FormError, Input, Select, Textarea } from '@/components/ui/form';
import { ApiError, publicApi } from '@/lib/api';
import { friendlyError } from '@/lib/errors';
import { fmtDay, fmtDuration, fmtTime, money } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PublicFrame } from './PublicFrame';
import { SlotPicker } from './SlotPicker';

interface SalonInfo {
  salon: { name: string; currency: string };
  branches: Array<{ id: string; name: string; addressLine1: string | null; city: string | null; phone: string | null; timezone: string }>;
  services: Array<{ id: string; name: string; description: string | null; category: string; durationMinutes: number; price: number; allBranches: boolean; branchIds: string[] }>;
}
interface Booked { bookingNumber: string; startAt: string; branchName: string; branchPhone: string | null; salonName: string; services: Array<{ name: string; staffName: string | null; startAt: string | null; durationMinutes: number; price: number }>; total: number; manageLink: string }

const STEPS = ['Services', 'Time', 'Your details'] as const;

export function Component() {
  const { code = '' } = useParams();
  const q = useQuery({ queryKey: ['public', 'salon', code], queryFn: () => publicApi.get<SalonInfo>(`/public/${code}`), retry: false });
  const [step, setStep] = useState(0);
  const [branchId, setBranchId] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [slot, setSlot] = useState<{ startAt: string; staffId: string | null } | null>(null);
  const [form, setForm] = useState({ fullName: '', mobile: '', email: '', notes: '', consent: false, website: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Booked | null>(null);

  const info = q.data;
  const branch = info?.branches.find((b) => b.id === (branchId || info.branches[0]?.id));
  const services = useMemo(() => (info && branch ? info.services.filter((s) => s.allBranches || s.branchIds.includes(branch.id)) : []), [info, branch]);
  const groups = useMemo(() => { const m = new Map<string, typeof services>(); for (const s of services) m.set(s.category, [...(m.get(s.category) ?? []), s]); return [...m.entries()]; }, [services]);
  const chosen = services.filter((s) => picked.includes(s.id));
  const total = chosen.reduce((a, s) => a + s.price, 0);
  const minutes = chosen.reduce((a, s) => a + s.durationMinutes, 0);
  const currency = info?.salon.currency ?? 'INR';

  const book = useMutation({
    mutationFn: () => publicApi.post<Booked>(`/public/${code}/bookings`, { branchId: branch!.id, serviceIds: picked, staffId: slot!.staffId, startAt: slot!.startAt, customer: { fullName: form.fullName.trim(), mobile: form.mobile.trim(), email: form.email.trim(), marketingConsent: form.consent }, notes: form.notes.trim(), website: form.website }),
    onSuccess: setDone,
    onError: (e) => {
      if (e instanceof ApiError) setErrors(Object.fromEntries(Object.entries(e.fieldErrors).map(([k, m]) => [k.replace(/^customer\./, ''), m])));
      if (e instanceof ApiError && e.errorCode === 'APPOINTMENT_CONFLICT') { setSlot(null); setStep(1); }
      setError(friendlyError(e).message);
    },
  });
  const submit = () => {
    const errs: Record<string, string> = {};
    if (form.fullName.trim().length < 2) errs.fullName = 'Please enter your name.';
    if (form.mobile.replace(/\D/g, '').length < 8) errs.mobile = 'Enter your mobile number so we can confirm your booking.';
    if (form.email && !/^\S+@\S+\.\S+$/.test(form.email)) errs.email = 'That email does not look right.';
    setErrors(errs);
    if (Object.keys(errs).length === 0) { setError(null); book.mutate(); }
  };

  if (q.isLoading) return <PublicFrame title="Book an appointment"><p role="status" className="py-16 text-center text-muted">Loading…</p></PublicFrame>;
  if (q.isError || !info || !branch) return <PublicFrame title="Book an appointment"><div className="rounded-2xl border border-line bg-surface p-8 text-center"><h2 className="text-lg font-semibold">Online booking is not available</h2><p className="mt-2 text-muted">Please contact the salon directly to book your appointment.</p></div></PublicFrame>;

  if (done) {
    const manage = (() => { try { return new URL(done.manageLink).pathname; } catch { return done.manageLink; } })();
    return (
      <PublicFrame title={info.salon.name}>
        <div className="rounded-2xl border border-line bg-surface p-6 shadow-card">
          <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-success-soft text-success"><Check className="size-6" aria-hidden /></div>
          <h2 className="text-xl font-semibold">You are booked in</h2>
          <p className="mt-1 text-muted">We have sent a confirmation to your phone. Booking {done.bookingNumber}.</p>
          <div className="mt-5 space-y-1 rounded-xl bg-surface-2 p-4">
            <p className="font-semibold">{fmtDay(done.startAt, branch.timezone, true)} at {fmtTime(done.startAt, branch.timezone)}</p>
            <p className="text-sm text-muted">{done.branchName}</p>
            <ul className="mt-2 space-y-1 text-sm">{done.services.map((s, i) => <li key={i} className="flex justify-between gap-3"><span>{s.name}{s.staffName ? ` with ${s.staffName}` : ''}</span><span className="text-muted">{fmtDuration(s.durationMinutes)}</span></li>)}</ul>
            <p className="mt-2 flex justify-between border-t border-line pt-2 text-sm font-semibold"><span>Estimated total</span><span>{money(done.total, currency)}</span></p>
          </div>
          <p className="mt-4 text-sm text-muted">Need to change your plans? Use your private link to move or cancel your booking.</p>
          <div className="mt-3 flex flex-wrap gap-2"><Link to={manage} className="inline-flex min-h-11 items-center rounded-xl bg-primary px-4 text-sm font-semibold text-primary-fg">Manage my booking</Link><Button variant="outline" size="lg" icon={<Copy className="size-4" />} onClick={() => void navigator.clipboard.writeText(`${window.location.origin}${manage}`)}>Copy link</Button></div>
          {done.branchPhone && <p className="mt-4 flex items-center gap-2 text-sm text-muted"><Phone className="size-4" aria-hidden />Questions? Call {done.branchPhone}</p>}
        </div>
      </PublicFrame>
    );
  }

  return (
    <PublicFrame title={info.salon.name} subtitle="Book your appointment online">
      <ol className="mb-5 flex items-center gap-2 text-sm" aria-label="Progress">
        {STEPS.map((label, i) => <li key={label} aria-current={i === step ? 'step' : undefined} className={cn('flex items-center gap-2', i === step ? 'font-semibold text-fg' : 'text-muted')}><span className={cn('flex size-6 items-center justify-center rounded-full border text-xs', i < step ? 'border-success bg-success text-white' : i === step ? 'border-primary bg-primary text-primary-fg' : 'border-line')}>{i < step ? <Check className="size-3.5" /> : i + 1}</span><span className="max-sm:sr-only">{label}</span>{i < STEPS.length - 1 && <span className="h-px w-6 bg-line" aria-hidden />}</li>)}
      </ol>

      {step === 0 && (
        <section aria-label="Choose services" className="space-y-5">
          {info.branches.length > 1 && <Field label="Which branch?"><Select value={branch.id} onChange={(e) => { setBranchId(e.target.value); setPicked([]); setSlot(null); }}>{info.branches.map((b) => <option key={b.id} value={b.id}>{b.name}{b.city ? `, ${b.city}` : ''}</option>)}</Select></Field>}
          {info.branches.length === 1 && <p className="flex items-center gap-2 text-sm text-muted"><MapPin className="size-4" aria-hidden />{[branch.name, branch.addressLine1, branch.city].filter(Boolean).join(', ')}</p>}
          {groups.length === 0 && <p className="rounded-xl border border-dashed border-line p-6 text-center text-muted">No services can be booked online at this branch right now.</p>}
          {groups.map(([category, items]) => (
            <div key={category}>
              <h2 className="mb-2 text-sm font-semibold text-muted">{category}</h2>
              <ul className="space-y-2">
                {items.map((s) => {
                  const on = picked.includes(s.id);
                  return (
                    <li key={s.id}><button type="button" aria-pressed={on} onClick={() => { setPicked(on ? picked.filter((x) => x !== s.id) : [...picked, s.id].slice(0, 5)); setSlot(null); }} className={cn('flex w-full items-center gap-3 rounded-xl border p-3.5 text-left transition-colors', on ? 'border-primary bg-primary-soft' : 'border-line bg-surface hover:border-primary/50')}>
                      <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-full border', on ? 'border-primary bg-primary text-primary-fg' : 'border-line')}>{on && <Check className="size-3.5" aria-hidden />}</span>
                      <span className="min-w-0 flex-1"><span className="block font-medium">{s.name}</span><span className="block text-sm text-muted">{fmtDuration(s.durationMinutes)}{s.description ? ` · ${s.description}` : ''}</span></span>
                      <span className="font-semibold tabular-nums">{money(s.price, currency)}</span>
                    </button></li>
                  );
                })}
              </ul>
            </div>
          ))}
        </section>
      )}

      {step === 1 && (
        <section aria-label="Choose a time" className="space-y-4">
          <p className="text-sm text-muted">{chosen.map((s) => s.name).join(', ')} · {fmtDuration(minutes)}</p>
          <SlotPicker code={code} branchId={branch.id} serviceIds={picked} timezone={branch.timezone} value={slot} onChange={setSlot} />
        </section>
      )}

      {step === 2 && slot && (
        <section aria-label="Your details" className="space-y-4">
          <div className="rounded-xl bg-surface-2 p-4 text-sm"><p className="font-semibold">{fmtDay(slot.startAt, branch.timezone, true)} at {fmtTime(slot.startAt, branch.timezone)}</p><p className="text-muted">{chosen.map((s) => s.name).join(', ')} · {branch.name}</p></div>
          <FormError message={error} />
          <Field label="Your name" required error={errors.fullName}><Input autoComplete="name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} /></Field>
          <Field label="Mobile number" required error={errors.mobile} hint="We send your confirmation and reminders here."><Input type="tel" inputMode="tel" autoComplete="tel" value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} /></Field>
          <Field label="Email" optional error={errors.email}><Input type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Anything we should know?" optional><Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
          <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden className="sr-only" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
          <Checkbox checked={form.consent} onCheckedChange={(v) => setForm({ ...form, consent: v })} label="Send me offers and news from this salon" description="Optional. You can say stop at any time." />
        </section>
      )}

      <div className="sticky bottom-0 -mx-4 mt-6 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-2xl sm:border">
        <div className="flex items-center gap-3">
          {step > 0 && <Button variant="outline" size="lg" icon={<ChevronLeft className="size-4" />} onClick={() => { setStep(step - 1); setError(null); }}>Back</Button>}
          <div className="min-w-0 flex-1 text-sm">{picked.length > 0 ? <><p className="font-semibold tabular-nums">{money(total, currency)}</p><p className="truncate text-muted">{picked.length} {picked.length === 1 ? 'service' : 'services'} · {fmtDuration(minutes)}</p></> : <p className="text-muted">Choose at least one service</p>}</div>
          {step === 0 && <Button size="lg" disabled={picked.length === 0} onClick={() => setStep(1)}>Choose a time</Button>}
          {step === 1 && <Button size="lg" disabled={!slot} onClick={() => setStep(2)}>Continue</Button>}
          {step === 2 && <Button size="lg" icon={<CalendarCheck className="size-4" />} loading={book.isPending} onClick={submit}>Confirm booking</Button>}
        </div>
      </div>
      <p className="mt-6 flex items-center justify-center gap-1.5 text-xs text-faint"><Scissors className="size-3" aria-hidden />Online booking by SalonOS</p>
    </PublicFrame>
  );
}
