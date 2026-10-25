import { scheduleOverrideSchema } from '@salon/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { toastError } from '@/app/providers';
import { Badge, Card, CardHeader, EmptyState } from '@/components/ui/display';
import { Button, IconButton } from '@/components/ui/button';
import { DateInput, Field, FormError, Input, Segmented, TimeInput } from '@/components/ui/form';
import { Modal } from '@/components/ui/overlay';
import { api, ApiError } from '@/lib/api';
import { friendlyError } from '@/lib/errors';
import { addDaysTo, fmtDay, todayIn } from '@/lib/format';

interface Override { id: string; date: string; isWorking: boolean; startTime: string | null; endTime: string | null; reason: string | null }

/** Exceptions to the weekly pattern: an extra Sunday, an early finish, or a day off. */
export function OneDayChanges({ staffId, timezone, canEdit }: { staffId: string; timezone: string; canEdit: boolean }) {
  const client = useQueryClient();
  const today = todayIn(timezone);
  const [adding, setAdding] = useState(false);
  const key = ['staff-overrides', staffId, today] as const;
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Override[]>(`/staff/${staffId}/overrides`, { from: today, to: addDaysTo(today, 90) }) });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/staff/${staffId}/overrides/${id}`),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['staff-overrides', staffId] }); void client.invalidateQueries({ queryKey: ['calendar'] }); toast.success('Change removed'); },
    onError: toastError,
  });
  return (
    <Card>
      <CardHeader title="Changes for specific days" description="These replace the weekly hours on that date only." actions={canEdit && <Button size="sm" variant="outline" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add a change</Button>} />
      {q.data?.length === 0 && <EmptyState title="No special days coming up" description="Use this for extra shifts, early finishes or a day off." />}
      <ul className="divide-y divide-line">
        {q.data?.map((o) => (
          <li key={o.id} className="flex items-center gap-3 py-2.5">
            <div className="min-w-0 flex-1"><p className="font-medium">{fmtDay(o.date, timezone, true)}</p><p className="text-sm text-muted">{o.reason ?? 'No reason given'}</p></div>
            {o.isWorking ? <Badge tone="info">{o.startTime?.slice(0, 5)} – {o.endTime?.slice(0, 5)}</Badge> : <Badge>Day off</Badge>}
            {canEdit && <IconButton label={`Remove change on ${o.date}`} size="sm" onClick={() => remove.mutate(o.id)}><Trash2 className="size-4" /></IconButton>}
          </li>
        ))}
      </ul>
      {adding && <AddChange staffId={staffId} today={today} onClose={() => setAdding(false)} />}
    </Card>
  );
}

function AddChange({ staffId, today, onClose }: { staffId: string; today: string; onClose: () => void }) {
  const client = useQueryClient();
  const [date, setDate] = useState(today);
  const [working, setWorking] = useState(false);
  const [start, setStart] = useState('10:00');
  const [end, setEnd] = useState('19:00');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const parsed = scheduleOverrideSchema.safeParse({ date, isWorking: working, startTime: working ? start : null, endTime: working ? end : null, reason });
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Check the details.');
      return api.post(`/staff/${staffId}/overrides`, parsed.data);
    },
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['staff-overrides', staffId] }); void client.invalidateQueries({ queryKey: ['calendar'] }); void client.invalidateQueries({ queryKey: ['availability'] }); toast.success('Change saved'); onClose(); },
    onError: (e) => setError(e instanceof Error && !(e instanceof ApiError) ? e.message : friendlyError(e).message),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Change one day" size="sm" footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate()}>Save change</Button></>}>
      <div className="space-y-4">
        <FormError message={error} />
        <Field label="Date" required><DateInput value={date} min={today} onChange={(e) => setDate(e.target.value)} /></Field>
        <Segmented label="What changes" value={working ? 'work' : 'off'} onChange={(v) => setWorking(v === 'work')} options={[{ value: 'off', label: 'Day off' }, { value: 'work', label: 'Different hours' }]} />
        {working && <div className="flex items-center gap-2"><TimeInput aria-label="Starts" value={start} onChange={(e) => setStart(e.target.value)} /><span className="text-muted">to</span><TimeInput aria-label="Ends" value={end} onChange={(e) => setEnd(e.target.value)} /></div>}
        <Field label="Reason" optional><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Festival rush, family function" /></Field>
        <p className="text-xs text-muted">Appointments already booked on that day are not moved. You will see them on the calendar.</p>
      </div>
    </Modal>
  );
}
