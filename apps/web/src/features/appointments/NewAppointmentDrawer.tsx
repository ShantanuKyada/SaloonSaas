import { APPOINTMENT_SOURCE_LABELS, APPOINTMENT_SOURCES, type AppointmentDto, type AvailabilityResult, type AppointmentSource } from '@salon/shared';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, ChevronDown, Package } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Money, useMoney } from '@/components/common/badges';
import { CustomerPicker, toPicked, useCustomer360, type PickedCustomer } from '@/components/common/CustomerPicker';
import { ServicePicker } from '@/components/common/ServicePicker';
import { Button } from '@/components/ui/button';
import { Badge, InlineNotice } from '@/components/ui/display';
import { Checkbox, DateInput, Field, Select, Switch, Textarea } from '@/components/ui/form';
import { Drawer } from '@/components/ui/overlay';
import type { NewAppointmentPrefill } from '@/features/quick/QuickActions';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { friendlyError } from '@/lib/errors';
import { addDaysTo, fmtDay, fmtDuration, fmtTime, localDate, todayIn } from '@/lib/format';
import { useServices, useStaffList } from '@/lib/queries';
import { AvailabilityPicker, type Slot } from './AvailabilityPicker';

const SECTION = 'space-y-3';
const H = ({ n, children }: { n: number; children: string }) => (
  <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
    <span className="grid size-6 place-items-center rounded-full bg-primary-soft text-xs text-primary-soft-fg">{n}</span>
    {children}
  </h3>
);

/** Book an appointment: Customer → Service → Time → Who → Confirm, with the usual choices already surfaced. */
export default function NewAppointmentDrawer({ prefill, onClose }: { prefill: NewAppointmentPrefill; onClose: () => void }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const can = useCan();
  const money = useMoney();
  const { branches, branchId: currentBranch } = useBranch();
  const [branchId, setBranchId] = useState(prefill.branchId ?? currentBranch);
  const branch = branches.find((b) => b.id === branchId) ?? branches[0]!;
  const tz = branch.timezone;

  const [customerId, setCustomerId] = useState<string | null>(prefill.customerId ?? null);
  const [picked, setPicked] = useState<PickedCustomer | null>(null);
  const loaded = useCustomer360(customerId);
  useEffect(() => {
    if (loaded.data) setPicked(toPicked(loaded.data));
  }, [loaded.data]);

  const [serviceIds, setServiceIds] = useState<string[]>(prefill.serviceId ? [prefill.serviceId] : []);
  const [date, setDate] = useState(prefill.date ?? (prefill.startAt ? localDate(prefill.startAt, tz) : todayIn(tz)));
  const [slot, setSlot] = useState<Slot | null>(prefill.startAt && prefill.staffId ? { startAt: prefill.startAt, staffId: prefill.staffId } : null);
  const [separate, setSeparate] = useState(false);
  const [laterStaff, setLaterStaff] = useState<Record<string, string>>({});
  const [usePackage, setUsePackage] = useState<Record<string, boolean>>({});
  const [moreOpen, setMoreOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [internalNotes, setInternalNotes] = useState('');
  const [source, setSource] = useState<AppointmentSource>('phone');
  const [confirmed, setConfirmed] = useState(false);
  const [notify, setNotify] = useState(true);
  const [allowOutside, setAllowOutside] = useState(false);

  const services = useServices(branchId, { popular: true });
  const lookup = useMemo(() => new Map((services.data ?? []).map((s) => [s.id, s])), [services.data]);
  const staffList = useStaffList(branchId, { bookableOnly: true });

  // Customer's usual services and team member help the receptionist start from something sensible.
  const usualIds = useMemo(() => [picked?.favoriteServiceId, picked?.suggestion?.serviceId].filter((v): v is string => !!v), [picked]);
  const preferredStaffId = picked?.preferredStaffId ?? picked?.suggestion?.staffId ?? null;

  const toggleService = (id: string) => {
    setServiceIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
    setSlot((s) => (prefill.startAt && prefill.staffId ? s : null));
    setSeparate(false);
  };

  // Together: everyone qualified for ALL services. Separate: only the first service decides the starting time.
  const availabilityIds = separate ? serviceIds.slice(0, 1) : serviceIds;
  const availability = useQuery({
    queryKey: ['availability', branchId, date, availabilityIds.join(','), customerId, allowOutside],
    queryFn: () => api.get<AvailabilityResult>('/scheduling/availability', { branchId, date, serviceIds: availabilityIds, customerId: customerId ?? undefined, allowOutsideHours: allowOutside ? 'true' : undefined }),
    enabled: availabilityIds.length > 0,
    staleTime: 10_000,
  });

  // If a prefilled time is no longer valid for the chosen services, drop it instead of failing at confirm.
  useEffect(() => {
    if (slot && availability.data && !availability.isFetching) {
      const ok = availability.data.slots.some((s) => s.startAt === slot.startAt && s.staffIds.includes(slot.staffId));
      if (!ok) setSlot(null);
    }
  }, [availability.data, availability.isFetching, slot]);

  // Nobody does all the services together → switch to "separate team members" automatically.
  useEffect(() => {
    if (!separate && serviceIds.length > 1 && availability.data && availability.data.staff.length === 0) setSeparate(true);
  }, [availability.data, separate, serviceIds.length]);

  // Estimated chain of start times for services after the first (to check who is free for each).
  const chain = useMemo(() => {
    if (!slot) return [] as Array<{ serviceId: string; startAt: string }>;
    let cursor = new Date(slot.startAt).getTime();
    return serviceIds.map((id, i) => {
      const s = lookup.get(id);
      const at = new Date(cursor).toISOString();
      cursor += ((s?.durationMinutes ?? 0) + (i < serviceIds.length - 1 ? s?.bufferMinutes ?? 0 : 0)) * 60_000;
      return { serviceId: id, startAt: at };
    });
  }, [slot, serviceIds, lookup]);
  const totalMinutes = serviceIds.reduce((a, id) => a + (lookup.get(id)?.durationMinutes ?? 0) + (lookup.get(id)?.bufferMinutes ?? 0), 0) - (lookup.get(serviceIds.at(-1) ?? '')?.bufferMinutes ?? 0);

  const laterQueries = useQueries({
    queries: separate
      ? chain.slice(1).map((c) => ({
          queryKey: ['availability', 'line', branchId, c.serviceId, c.startAt],
          queryFn: () => api.get<AvailabilityResult>('/scheduling/availability', { branchId, date, serviceIds: [c.serviceId], startAt: c.startAt, allowOutsideHours: allowOutside ? 'true' : undefined }),
          staleTime: 10_000,
        }))
      : [],
  });
  const laterOptions = (i: number) => laterQueries[i]?.data?.staff ?? [];
  const staffForLine = (i: number): string | undefined => {
    if (i === 0 || !separate) return slot?.staffId;
    const id = serviceIds[i]!;
    const chosen = laterStaff[id];
    if (chosen) return chosen;
    const opts = laterOptions(i - 1);
    return opts.find((o) => o.state === 'available' && o.staffId === slot?.staffId)?.staffId ?? opts.find((o) => o.state === 'available')?.staffId;
  };

  // Packages the customer already owns that cover these services.
  const packageFor = (serviceId: string) => {
    const now = Date.now();
    for (const p of picked?.packages ?? []) {
      if (p.status !== 'active' || new Date(p.expiresAt).getTime() < now) continue;
      const item = p.items.find((i) => i.serviceId === serviceId && i.remaining > 0);
      if (item) return { packageName: p.packageName, itemId: item.id, remaining: item.remaining };
    }
    return null;
  };

  const create = useMutation({
    mutationFn: () => {
      const items = serviceIds.map((serviceId, i) => {
        const pkg = packageFor(serviceId);
        return {
          serviceId,
          staffId: staffForLine(i)!,
          startAt: i === 0 ? slot!.startAt : undefined,
          customerPackageItemId: pkg && usePackage[serviceId] !== false ? pkg.itemId : undefined,
        };
      });
      return api.post<AppointmentDto>('/appointments', { branchId, customerId, source, status: confirmed ? 'confirmed' : 'scheduled', notes: notes || null, internalNotes: internalNotes || null, items, notifyCustomer: notify, allowOutsideHours: allowOutside });
    },
    onSuccess: (a) => {
      for (const key of ['appointments', 'calendar', 'customer-360', 'dashboard', 'availability', 'walkins']) void client.invalidateQueries({ queryKey: [key] });
      toast.success(`Booked ${a.customer.fullName.split(' ')[0]} · ${fmtDay(a.startAt, tz)} ${fmtTime(a.startAt, tz)}`, { description: `${a.items.map((i) => `${i.serviceName} with ${i.staffName}`).join(', ')} · ${a.bookingNumber}`, action: { label: 'View', onClick: () => navigate(`/appointments/${a.id}`) } });
      prefill.onCreated?.(a.id);
      onClose();
    },
  });

  const allStaffChosen = serviceIds.every((_, i) => !!staffForLine(i));
  const ready = !!customerId && serviceIds.length > 0 && !!slot && allStaffChosen;
  const missing = !customerId ? 'Choose a customer' : serviceIds.length === 0 ? 'Choose at least one service' : !slot ? 'Choose a time' : !allStaffChosen ? 'Choose a team member for each service' : null;

  const err = create.error ? friendlyError(create.error) : null;
  const startForSummary = slot?.startAt;
  const endForSummary = startForSummary ? new Date(new Date(startForSummary).getTime() + totalMinutes * 60_000).toISOString() : null;
  const estimate = serviceIds.reduce((a, id) => a + (packageFor(id) && usePackage[id] !== false ? 0 : (lookup.get(id)?.price ?? 0)), 0);
  const quickDates = [0, 1, 2].map((d) => addDaysTo(todayIn(tz), d));

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title="New appointment"
      description={branches.length > 1 ? branch.name : undefined}
      size="lg"
      persistent
      footer={
        <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 text-sm">
            {ready && startForSummary && endForSummary ? (
              <p>
                <span className="font-semibold text-fg">{picked?.fullName}</span> · {fmtDay(startForSummary, tz)}, {fmtTime(startForSummary, tz)}–{fmtTime(endForSummary, tz)} · {fmtDuration(totalMinutes)} · <span className="font-semibold">{money(estimate)}</span>
              </p>
            ) : (
              <p className="text-muted">{missing}</p>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={() => create.mutate()} disabled={!ready} loading={create.isPending} icon={<CalendarCheck className="size-4" />}>
              Confirm booking
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-6">
        {err && (
          <InlineNotice tone="danger" title={err.title}>
            <p>{err.message}</p>
            {err.hints.length > 0 && <p className="mt-1 font-medium">{err.hints.join(' · ')}</p>}
          </InlineNotice>
        )}

        {branches.length > 1 && !prefill.branchId && (
          <Field label="Branch">
            <Select value={branchId} onChange={(e) => { setBranchId(e.target.value); setSlot(null); setServiceIds([]); }}>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </Field>
        )}

        <section className={SECTION}>
          <H n={1}>Customer</H>
          <CustomerPicker value={customerId} onChange={(c) => { setCustomerId(c?.id ?? null); setPicked(c); if (!c) setSlot(null); }} autoFocus={!prefill.customerId} />
          {picked?.suggestion && serviceIds.length === 0 && (
            <button type="button" onClick={() => toggleService(picked.suggestion!.serviceId)} className="text-sm font-medium text-primary hover:underline">
              Book their usual: {picked.suggestion.serviceName}
            </button>
          )}
        </section>

        <section className={SECTION}>
          <H n={2}>Services</H>
          {services.isLoading ? <div className="skeleton h-40" /> : <ServicePicker services={services.data ?? []} selected={serviceIds} onToggle={toggleService} usualIds={usualIds} />}
          {serviceIds.some((id) => packageFor(id)) && (
            <div className="space-y-2 rounded-xl border border-success/30 bg-success-soft p-3">
              {serviceIds.filter((id) => packageFor(id)).map((id) => {
                const pkg = packageFor(id)!;
                return (
                  <Checkbox key={id} checked={usePackage[id] !== false} onCheckedChange={(v) => setUsePackage((p) => ({ ...p, [id]: v }))} label={<span className="inline-flex items-center gap-1.5"><Package className="size-4" aria-hidden />Use package for {lookup.get(id)?.name}</span>} description={`${pkg.packageName} — ${pkg.remaining} session${pkg.remaining === 1 ? '' : 's'} left. Nothing to pay for this service.`} />
                );
              })}
            </div>
          )}
        </section>

        <section className={SECTION}>
          <H n={3}>When and who</H>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Date" className="w-44">
              <DateInput value={date} min={todayIn(tz)} onChange={(e) => { setDate(e.target.value); setSlot(null); }} />
            </Field>
            <div className="flex gap-1.5 pb-0.5">
              {quickDates.map((d, i) => (
                <button key={d} type="button" onClick={() => { setDate(d); setSlot(null); }} aria-pressed={date === d} className={`rounded-lg border px-3 py-2 text-sm font-medium max-md:min-h-11 ${date === d ? 'border-primary bg-primary-soft text-primary-soft-fg' : 'border-line hover:border-primary/50'}`}>
                  {i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : fmtDay(d, tz).split(',')[0]}
                </button>
              ))}
            </div>
          </div>
          {serviceIds.length === 0 ? (
            <p className="rounded-lg bg-surface-2 px-3 py-2.5 text-sm text-muted">Choose a service to see who is free and when.</p>
          ) : (
            <AvailabilityPicker availability={availability.data} loading={availability.isLoading} value={slot} onChange={setSlot} timezone={tz} preferredStaffId={preferredStaffId} />
          )}
          {availability.isError && <InlineNotice tone="danger" title="Could not check availability">{friendlyError(availability.error).message}</InlineNotice>}

          {serviceIds.length > 1 && slot && (
            <div className="space-y-2 rounded-xl border border-line p-3">
              <Switch checked={separate} onCheckedChange={(v) => { setSeparate(v); setLaterStaff({}); setSlot(null); }} label="Different team members for each service" description={separate ? 'Pick who does each service below. Each starts right after the previous one.' : 'One person does everything, back to back.'} />
              {separate && (
                <ul className="space-y-2 pt-1">
                  {serviceIds.map((id, i) => (
                    <li key={id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <span className="font-medium">{lookup.get(id)?.name} <span className="font-normal text-muted">· {fmtTime(chain[i]?.startAt, tz)}</span></span>
                      {i === 0 ? (
                        <Badge tone="primary">{staffList.data?.find((s) => s.id === slot.staffId)?.displayName ?? 'Chosen above'}</Badge>
                      ) : (
                        <Select aria-label={`Team member for ${lookup.get(id)?.name}`} className="w-56" value={staffForLine(i) ?? ''} onChange={(e) => setLaterStaff((m) => ({ ...m, [id]: e.target.value }))}>
                          {laterOptions(i - 1).length === 0 && <option value="">Checking…</option>}
                          {laterOptions(i - 1).map((o) => (
                            <option key={o.staffId} value={o.staffId} disabled={o.state !== 'available'}>
                              {o.displayName} — {o.label}
                            </option>
                          ))}
                        </Select>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>

        <section>
          <button type="button" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)} className="flex items-center gap-1.5 text-sm font-medium text-primary">
            <ChevronDown className={`size-4 transition-transform ${moreOpen ? 'rotate-180' : ''}`} />
            More options
          </button>
          {moreOpen && (
            <div className="mt-3 space-y-4">
              <Field label="Notes for the team" optional hint="Visible to the team member, e.g. “wants a shorter cut”.">
                <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
              <Field label="Internal remarks" optional hint="Not shown to the team member.">
                <Textarea rows={2} value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} />
              </Field>
              <Field label="How was it booked?">
                <Select value={source} onChange={(e) => setSource(e.target.value as AppointmentSource)}>
                  {APPOINTMENT_SOURCES.filter((s) => s !== 'walk_in' && s !== 'online').map((s) => <option key={s} value={s}>{APPOINTMENT_SOURCE_LABELS[s]}</option>)}
                </Select>
              </Field>
              <Switch checked={confirmed} onCheckedChange={setConfirmed} label="Mark as confirmed" description="The customer has confirmed they are coming." />
              <Switch checked={notify} onCheckedChange={setNotify} label="Send a confirmation to the customer" description="Sent by WhatsApp or email if they have agreed to messages. Reminders are scheduled automatically." />
              {can('appointments.override_hours') && <Switch checked={allowOutside} onCheckedChange={(v) => { setAllowOutside(v); setSlot(null); }} label="Allow outside working hours" description="Manager option for special requests, such as an early bridal booking." />}
            </div>
          )}
        </section>

        {picked && picked.outstanding > 0 && (
          <InlineNotice tone="warning" title={<span>{picked.fullName.split(' ')[0]} has <Money value={picked.outstanding} /> pending</span>} action={<Link to={`/billing/collect?customerId=${picked.id}`} onClick={onClose} className="text-sm font-medium underline">Collect payment</Link>}>
            You can still book. It is just a reminder to collect when they visit.
          </InlineNotice>
        )}
      </div>
    </Drawer>
  );
}
