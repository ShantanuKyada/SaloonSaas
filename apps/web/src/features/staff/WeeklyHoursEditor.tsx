import { WEEKDAYS, WEEKDAY_LABELS, staffWeeklyScheduleSchema } from '@salon/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, IconButton } from '@/components/ui/button';
import { FormError, Switch, TimeInput } from '@/components/ui/form';
import { api, ApiError } from '@/lib/api';
import { friendlyError } from '@/lib/errors';
import { staffDetailKey, type StaffDetail } from './hooks';

interface Window { startTime: string; endTime: string }
interface Day { shifts: Window[]; breaks: Array<Window & { label: string }> }
type Week = Record<number, Day>;

function toWeek(schedule: StaffDetail['weeklySchedule']): Week {
  const week: Week = {};
  for (const d of WEEKDAYS) {
    week[d] = {
      shifts: schedule.shifts.filter((s) => s.weekday === d).map((s) => ({ startTime: s.startTime, endTime: s.endTime })),
      breaks: schedule.breaks.filter((b) => b.weekday === d).map((b) => ({ startTime: b.startTime, endTime: b.endTime, label: b.label })),
    };
  }
  return week;
}

/** Weekly working hours with breaks. Days with no shift are the weekly off. */
export function WeeklyHoursEditor({ staff, onSaved }: { staff: StaffDetail; onSaved?: () => void }) {
  const client = useQueryClient();
  const [week, setWeek] = useState<Week>(() => toWeek(staff.weeklySchedule));
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const change = (fn: (w: Week) => Week) => { setWeek(fn); setDirty(true); setError(null); };
  const patchDay = (d: number, fn: (day: Day) => Day) => change((w) => ({ ...w, [d]: fn(w[d]!) }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        shifts: WEEKDAYS.flatMap((d) => week[d]!.shifts.map((s) => ({ weekday: d, ...s }))),
        breaks: WEEKDAYS.flatMap((d) => week[d]!.breaks.map((b) => ({ weekday: d, ...b }))),
      };
      const parsed = staffWeeklyScheduleSchema.safeParse(body);
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Check the times you entered.');
      return api.put<StaffDetail>(`/staff/${staff.id}/schedule`, parsed.data);
    },
    onSuccess: (saved) => {
      client.setQueryData(staffDetailKey(staff.id), saved);
      void client.invalidateQueries({ queryKey: ['calendar'] });
      void client.invalidateQueries({ queryKey: ['availability'] });
      setDirty(false);
      toast.success('Working hours saved');
      onSaved?.();
    },
    onError: (e) => setError(e instanceof Error && !(e instanceof ApiError) ? e.message : friendlyError(e).message),
  });

  const copyToWorkingDays = (from: number) => change((w) => Object.fromEntries(WEEKDAYS.map((d) => [d, w[d]!.shifts.length ? structuredClone(w[from]!) : w[d]!])) as Week);

  return (
    <div className="space-y-3">
      <FormError message={error} />
      <ul className="space-y-2">
        {WEEKDAYS.map((d) => {
          const day = week[d]!;
          const working = day.shifts.length > 0;
          return (
            <li key={d} className="rounded-xl border border-line p-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="w-32"><Switch checked={working} onCheckedChange={(on) => patchDay(d, (x) => (on ? { ...x, shifts: [{ startTime: '10:00', endTime: '19:00' }] } : { shifts: [], breaks: [] }))} label={WEEKDAY_LABELS[d]} /></div>
                {!working && <span className="text-sm text-muted">Day off</span>}
                {working && (
                  <div className="flex flex-1 flex-wrap items-center gap-x-4 gap-y-2">
                    {day.shifts.map((s, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <TimeInput aria-label={`${WEEKDAY_LABELS[d]} start`} value={s.startTime} onChange={(e) => patchDay(d, (x) => ({ ...x, shifts: x.shifts.map((y, j) => (j === i ? { ...y, startTime: e.target.value } : y)) }))} className="w-28" />
                        <span className="text-muted">to</span>
                        <TimeInput aria-label={`${WEEKDAY_LABELS[d]} end`} value={s.endTime} onChange={(e) => patchDay(d, (x) => ({ ...x, shifts: x.shifts.map((y, j) => (j === i ? { ...y, endTime: e.target.value } : y)) }))} className="w-28" />
                        {day.shifts.length > 1 && <IconButton label="Remove this shift" size="sm" onClick={() => patchDay(d, (x) => ({ ...x, shifts: x.shifts.filter((_, j) => j !== i) }))}><Trash2 className="size-4" /></IconButton>}
                      </div>
                    ))}
                  </div>
                )}
                {working && (
                  <div className="ml-auto flex gap-1">
                    <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => patchDay(d, (x) => ({ ...x, shifts: [...x.shifts, { startTime: '16:00', endTime: '20:00' }] }))}>Split shift</Button>
                    <Button size="sm" variant="ghost" icon={<Copy className="size-4" />} onClick={() => copyToWorkingDays(d)}>Copy to other days</Button>
                  </div>
                )}
              </div>
              {working && (
                <div className="mt-2 space-y-2 pl-0 sm:pl-[8.5rem]">
                  {day.breaks.map((b, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="w-14 text-muted">Break</span>
                      <TimeInput aria-label={`${WEEKDAY_LABELS[d]} break start`} value={b.startTime} onChange={(e) => patchDay(d, (x) => ({ ...x, breaks: x.breaks.map((y, j) => (j === i ? { ...y, startTime: e.target.value } : y)) }))} className="w-28" />
                      <span className="text-muted">to</span>
                      <TimeInput aria-label={`${WEEKDAY_LABELS[d]} break end`} value={b.endTime} onChange={(e) => patchDay(d, (x) => ({ ...x, breaks: x.breaks.map((y, j) => (j === i ? { ...y, endTime: e.target.value } : y)) }))} className="w-28" />
                      <IconButton label="Remove break" size="sm" onClick={() => patchDay(d, (x) => ({ ...x, breaks: x.breaks.filter((_, j) => j !== i) }))}><Trash2 className="size-4" /></IconButton>
                    </div>
                  ))}
                  <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => patchDay(d, (x) => ({ ...x, breaks: [...x.breaks, { startTime: '13:00', endTime: '14:00', label: 'Lunch' }] }))}>Add a break</Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="sticky bottom-0 -mx-1 flex items-center justify-end gap-3 border-t border-line bg-surface/95 px-1 py-3 backdrop-blur">
        {dirty && <span className="text-sm text-muted">You have unsaved changes.</span>}
        <Button variant="outline" disabled={!dirty} onClick={() => { setWeek(toWeek(staff.weeklySchedule)); setDirty(false); setError(null); }}>Undo changes</Button>
        <Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>Save working hours</Button>
      </div>
    </div>
  );
}
