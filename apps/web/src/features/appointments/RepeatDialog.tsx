import type { AppointmentDto, RepeatResultDto } from '@salon/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, CalendarX } from 'lucide-react';
import { useState } from 'react';
import { toastError } from '@/app/providers';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/display';
import { Field, Select } from '@/components/ui/form';
import { Modal } from '@/components/ui/overlay';
import { api } from '@/lib/api';
import { fmtDay, fmtTime } from '@/lib/format';

export const REPEAT_WEEKS = [1, 2, 3, 4, 5, 6, 8, 10, 12];
export const REPEAT_TIMES = [2, 3, 4, 5, 6, 8, 10, 12];
const WEEK_MS = 7 * 86_400_000;

export const everyLabel = (weeks: number) => (weeks === 1 ? 'Every week' : `Every ${weeks} weeks`);

/** The dates a repeat would take, for a preview before anything is booked. */
export function repeatDates(startAt: string, everyWeeks: number, times: number): string[] {
  return Array.from({ length: times }, (_, k) => new Date(new Date(startAt).getTime() + k * everyWeeks * WEEK_MS).toISOString());
}

/** What happened: the visits booked (and with whom, when someone else had to step in) and the dates nobody could do. */
export function RepeatOutcome({ result, timezone }: { result: RepeatResultDto; timezone: string }) {
  return (
    <div className="space-y-3 text-sm">
      {result.booked.length > 0 && (
        <div>
          <p className="mb-1 font-semibold">{result.booked.length === 1 ? '1 more visit booked' : `${result.booked.length} more visits booked`}</p>
          <ul className="space-y-1">
            {result.booked.map((b) => (
              <li key={b.id} className="flex items-start gap-2"><CalendarCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /><span>{fmtDay(b.startAt, timezone, true)} at {fmtTime(b.startAt, timezone)} · {b.staffNames.join(', ')}{b.staffChanged ? <span className="text-muted"> (the usual person is busy then)</span> : null}</span></li>
            ))}
          </ul>
        </div>
      )}
      {result.skipped.length > 0 && (
        <div>
          <p className="mb-1 font-semibold">{result.skipped.length === 1 ? '1 date could not be booked' : `${result.skipped.length} dates could not be booked`}</p>
          <ul className="space-y-1">
            {result.skipped.map((s) => (
              <li key={s.startAt} className="flex items-start gap-2"><CalendarX className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden /><span>{fmtDay(s.startAt, timezone, true)}: <span className="text-muted">{s.reason}</span></span></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Front desk: repeat a booking every few weeks (same services and time; same person when they are free). */
export function RepeatDialog({ appointment, timezone, onClose }: { appointment: AppointmentDto; timezone: string; onClose: () => void }) {
  const client = useQueryClient();
  const [everyWeeks, setEveryWeeks] = useState(4);
  const [times, setTimes] = useState(6);
  const [result, setResult] = useState<RepeatResultDto | null>(null);
  const repeat = useMutation({
    mutationFn: () => api.post<RepeatResultDto>(`/appointments/${appointment.id}/repeat`, { everyWeeks, times }),
    onSuccess: async (r) => { setResult(r); await client.invalidateQueries(); },
    onError: toastError,
  });
  const dates = appointment.startAt ? repeatDates(appointment.startAt, everyWeeks, times) : [];

  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={result ? 'Repeat booked' : 'Repeat this booking'} description={`${appointment.customer.fullName} · ${appointment.items.map((i) => i.serviceName).join(', ')}`} size="sm"
      footer={result ? <Button onClick={onClose}>Done</Button> : <><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={repeat.isPending} onClick={() => repeat.mutate()}>Book {times - 1} more {times - 1 === 1 ? 'visit' : 'visits'}</Button></>}>
      {result ? (
        <RepeatOutcome result={result} timezone={timezone} />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="How often"><Select value={everyWeeks} onChange={(e) => setEveryWeeks(Number(e.target.value))}>{REPEAT_WEEKS.map((w) => <option key={w} value={w}>{everyLabel(w)}</option>)}</Select></Field>
            <Field label="Visits in all"><Select value={times} onChange={(e) => setTimes(Number(e.target.value))}>{REPEAT_TIMES.map((n) => <option key={n} value={n}>{n} visits</option>)}</Select></Field>
          </div>
          <div>
            <p className="mb-1 text-sm font-medium">Dates</p>
            <ol className="space-y-0.5 text-sm text-muted">{dates.map((d, i) => <li key={d}>{fmtDay(d, timezone, true)} at {fmtTime(d, timezone)}{i === 0 ? ' (this booking)' : ''}</li>)}</ol>
          </div>
          <InlineNotice tone="info">Each visit is booked with the same person when they are free; otherwise with someone else who does these services. Dates nobody can do are skipped and listed. The customer gets reminders before each visit.</InlineNotice>
        </div>
      )}
    </Modal>
  );
}
