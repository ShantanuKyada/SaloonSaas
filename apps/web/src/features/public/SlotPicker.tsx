import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/display';
import { publicApi } from '@/lib/api';
import { addDaysTo, fmtDay, fmtTime, todayIn, weekdayOf } from '@/lib/format';
import { cn } from '@/lib/utils';

interface Availability { date: string; timezone: string; beyondBookingWindowDays: number | null; totalDurationMinutes: number; staff: Array<{ staffId: string; displayName: string; slots: string[] }>; slots: Array<{ startAt: string; staffIds: string[] }> }

const SHORT = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Pick a day from a strip, then a start time. Only times that can really be booked are ever shown. */
export function SlotPicker({ code, branchId, serviceIds, timezone, value, onChange }: { code: string; branchId: string; serviceIds: string[]; timezone: string; value: { startAt: string; staffId: string | null } | null; onChange: (v: { startAt: string; staffId: string | null } | null) => void }) {
  const today = todayIn(timezone);
  const [start, setStart] = useState(today);
  const [date, setDate] = useState(today);
  const [staffId, setStaffId] = useState<string>('');
  const days = Array.from({ length: 7 }, (_, i) => addDaysTo(start, i));
  const q = useQuery({
    queryKey: ['public', 'availability', code, branchId, date, serviceIds.join(',')],
    queryFn: () => publicApi.get<Availability>(`/public/${code}/availability`, { branchId, date, serviceIds }),
    enabled: serviceIds.length > 0,
  });
  useEffect(() => { onChange(null); }, [date, staffId]);
  const staff = q.data?.staff ?? [];
  const slots = staffId ? staff.find((s) => s.staffId === staffId)?.slots ?? [] : (q.data?.slots ?? []).map((s) => s.startAt);

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 flex items-center justify-between"><p className="text-sm font-medium">{fmtDay(date, timezone, true)}</p><div className="flex gap-1"><button type="button" className="rounded-lg border border-line px-2.5 py-1 text-sm disabled:opacity-40" disabled={start <= today} onClick={() => setStart(addDaysTo(start, -7))}>← Earlier</button><button type="button" className="rounded-lg border border-line px-2.5 py-1 text-sm" onClick={() => setStart(addDaysTo(start, 7))}>Later →</button></div></div>
        <div role="group" aria-label="Choose a day" className="grid grid-cols-7 gap-1.5">
          {days.map((d) => { const on = d === date; return <button key={d} type="button" aria-pressed={on} disabled={d < today} onClick={() => setDate(d)} className={cn('flex flex-col items-center rounded-xl border py-2 text-sm disabled:opacity-40 max-md:min-h-14', on ? 'border-primary bg-primary text-primary-fg' : 'border-line bg-surface hover:border-primary/50')}><span className="text-[11px] uppercase opacity-80">{SHORT[weekdayOf(d)]}</span><span className="text-base font-semibold">{Number(d.slice(8))}</span></button>; })}
        </div>
      </div>
      {staff.length > 1 && (
        <div role="group" aria-label="Who would you like?" className="flex flex-wrap gap-2">
          <button type="button" aria-pressed={staffId === ''} onClick={() => setStaffId('')} className={cn('rounded-full border px-3 py-1.5 text-sm max-md:min-h-10', staffId === '' ? 'border-primary bg-primary-soft text-primary-soft-fg' : 'border-line')}>Anyone</button>
          {staff.map((s) => <button key={s.staffId} type="button" aria-pressed={staffId === s.staffId} onClick={() => setStaffId(s.staffId)} className={cn('rounded-full border px-3 py-1.5 text-sm max-md:min-h-10', staffId === s.staffId ? 'border-primary bg-primary-soft text-primary-soft-fg' : 'border-line')}>{s.displayName}</button>)}
        </div>
      )}
      {q.isLoading && <div role="status" aria-label="Finding times" className="grid grid-cols-3 gap-2 sm:grid-cols-4"><Skeleton className="h-11" /><Skeleton className="h-11" /><Skeleton className="h-11" /><Skeleton className="h-11" /></div>}
      {q.isError && <p role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">We could not load times just now. Please try again.</p>}
      {q.data && slots.length === 0 && <p className="rounded-xl border border-dashed border-line p-4 text-center text-sm text-muted">{q.data.beyondBookingWindowDays ? `You can book up to ${q.data.beyondBookingWindowDays} days ahead. Please choose an earlier day.` : 'No times are free on this day. Please try another day.'}</p>}
      {slots.length > 0 && (
        <div role="group" aria-label="Choose a time" className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {slots.map((iso) => { const on = value?.startAt === iso; return <button key={iso} type="button" aria-pressed={on} onClick={() => onChange({ startAt: iso, staffId: staffId || null })} className={cn('min-h-11 rounded-xl border px-2 text-sm font-medium', on ? 'border-primary bg-primary text-primary-fg' : 'border-line bg-surface hover:border-primary/50')}>{fmtTime(iso, timezone)}</button>; })}
        </div>
      )}
    </div>
  );
}
