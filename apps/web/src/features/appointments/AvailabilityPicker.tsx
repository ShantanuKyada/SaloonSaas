import type { AvailabilityResult, StaffAvailability, StaffAvailabilityState } from '@salon/shared';
import { useMemo, useState } from 'react';
import { Avatar, Badge, type Tone } from '@/components/ui/display';
import { fmtTime } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface Slot {
  staffId: string;
  startAt: string;
}

const STATE_TONE: Record<StaffAvailabilityState, Tone> = { available: 'success', busy: 'warning', blocked: 'warning', outside_hours: 'neutral', on_leave: 'info', not_working: 'neutral', not_qualified: 'neutral' };

/**
 * "Times first, then who": one row of valid start times across everyone qualified; picking a time selects the
 * customer's usual team member when free, and everyone else's status is spelled out in plain words.
 */
export function AvailabilityPicker({ availability, value, onChange, timezone, preferredStaffId, loading }: { availability: AvailabilityResult | undefined; value: Slot | null; onChange: (slot: Slot | null) => void; timezone: string; preferredStaffId?: string | null; loading?: boolean }) {
  const [filter, setFilter] = useState<'any' | string>('any');
  const [showAllTimes, setShowAllTimes] = useState(false);

  const staff = availability?.staff ?? [];
  const times = useMemo(() => {
    if (!availability) return [];
    return availability.slots.filter((s) => filter === 'any' || s.staffIds.includes(filter));
  }, [availability, filter]);
  const visibleTimes = showAllTimes ? times : times.slice(0, 18);

  if (loading && !availability) return <div role="status" aria-label="Checking availability" className="space-y-2"><div className="skeleton h-10" /><div className="skeleton h-24" /></div>;
  if (!availability) return null;

  if (availability.beyondBookingWindowDays) {
    return <p className="rounded-lg bg-warning-soft px-3 py-2.5 text-sm text-warning">Bookings can be made up to {availability.beyondBookingWindowDays} days ahead. Choose an earlier date.</p>;
  }
  if (!availability.branchOpen) {
    return <p className="rounded-lg bg-warning-soft px-3 py-2.5 text-sm text-warning">The salon is closed on this day{availability.holiday ? ` (${availability.holiday})` : ''}. Choose another date.</p>;
  }
  if (staff.length === 0) {
    return <p className="rounded-lg bg-warning-soft px-3 py-2.5 text-sm text-warning">Nobody is set up to do all of these services together. Try booking them one at a time, or ask your manager to assign the service to a team member.</p>;
  }

  const pick = (startAt: string, staffIds: string[]) => {
    const preferred = filter !== 'any' ? filter : preferredStaffId && staffIds.includes(preferredStaffId) ? preferredStaffId : staffIds[0]!;
    onChange({ staffId: preferred, startAt });
  };
  const selectedStaffOptions = value ? times.find((t) => t.startAt === value.startAt)?.staffIds ?? [] : [];

  return (
    <div className="space-y-4">
      {staff.length > 1 && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Show times for">
          <span className="text-xs font-medium text-muted">Show times for</span>
          <button type="button" aria-pressed={filter === 'any'} onClick={() => setFilter('any')} className={cn('rounded-full border px-3 py-1 text-xs font-medium max-md:min-h-9', filter === 'any' ? 'border-primary bg-primary-soft text-primary-soft-fg' : 'border-line text-muted hover:text-fg')}>
            Anyone
          </button>
          {staff.map((s) => (
            <button key={s.staffId} type="button" aria-pressed={filter === s.staffId} onClick={() => setFilter(s.staffId)} className={cn('inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium max-md:min-h-9', filter === s.staffId ? 'border-primary bg-primary-soft text-primary-soft-fg' : 'border-line text-muted hover:text-fg')}>
              <span className="size-2 rounded-full" style={{ background: s.color }} aria-hidden />
              {s.displayName}
              {s.isPreferred && <span className="text-[10px] opacity-70">usual</span>}
            </button>
          ))}
        </div>
      )}

      {times.length === 0 ? (
        <p className="rounded-lg bg-warning-soft px-3 py-2.5 text-sm text-warning">No free times left on this day{filter !== 'any' ? ' for this team member' : ''}. Try another day{filter !== 'any' ? ' or choose “Anyone”' : ''}.</p>
      ) : (
        <div>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6" role="listbox" aria-label="Available start times">
            {visibleTimes.map((t) => {
              const on = value?.startAt === t.startAt;
              return (
                <button key={t.startAt} type="button" role="option" aria-selected={on} onClick={() => pick(t.startAt, t.staffIds)} className={cn('rounded-lg border px-2 py-2 text-sm font-medium tabular-nums transition-colors max-md:min-h-11', on ? 'border-primary bg-primary text-primary-fg' : 'border-line bg-surface hover:border-primary/60')}>
                  {fmtTime(t.startAt, timezone)}
                  {filter === 'any' && t.staffIds.length > 1 && <span className="block text-[10px] font-normal opacity-70">{t.staffIds.length} free</span>}
                </button>
              );
            })}
          </div>
          {times.length > 18 && (
            <button type="button" className="mt-2 text-sm font-medium text-primary hover:underline" onClick={() => setShowAllTimes((s) => !s)}>
              {showAllTimes ? 'Show fewer times' : `Show all ${times.length} times`}
            </button>
          )}
        </div>
      )}

      {value && selectedStaffOptions.length > 1 && (
        <div role="radiogroup" aria-label="Team member">
          <p className="mb-1.5 text-xs font-medium text-muted">Who? <span className="font-normal">({selectedStaffOptions.length} free at {fmtTime(value.startAt, timezone)})</span></p>
          <div className="flex flex-wrap gap-2">
            {selectedStaffOptions.map((id) => {
              const s = staff.find((x) => x.staffId === id)!;
              const on = value.staffId === id;
              return (
                <button key={id} type="button" role="radio" aria-checked={on} onClick={() => onChange({ ...value, staffId: id })} className={cn('flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium max-md:min-h-11', on ? 'border-primary bg-primary-soft text-primary-soft-fg' : 'border-line hover:border-primary/60')}>
                  <Avatar name={s.displayName} color={s.color} size="sm" />
                  {s.displayName}
                  {s.isPreferred && <Badge tone="primary">Usual</Badge>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <StaffStatusList staff={staff} timezone={timezone} selectedStaffId={value?.staffId ?? null} />
    </div>
  );
}

/** "Rahul — Available · Amit — Busy until 6:30 PM · Priya — On leave": the answer a customer on the phone wants. */
function StaffStatusList({ staff, selectedStaffId }: { staff: StaffAvailability[]; timezone: string; selectedStaffId: string | null }) {
  return (
    <ul className="grid gap-1.5 sm:grid-cols-2" aria-label="Team availability">
      {staff.map((s) => (
        <li key={s.staffId} className={cn('flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm', selectedStaffId === s.staffId ? 'border-primary/50 bg-primary-soft/40' : 'border-line')}>
          <span className="flex min-w-0 items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden />
            <span className="truncate font-medium">{s.displayName}</span>
          </span>
          <Badge tone={STATE_TONE[s.state]}>{s.label}</Badge>
        </li>
      ))}
    </ul>
  );
}
