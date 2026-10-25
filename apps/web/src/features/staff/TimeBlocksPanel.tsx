import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { toastError } from '@/app/providers';
import { Card, EmptyState, ErrorState } from '@/components/ui/display';
import { Button, IconButton } from '@/components/ui/button';
import { DateInput, Field, FormError, Input, Select, TimeInput } from '@/components/ui/form';
import { Modal } from '@/components/ui/overlay';
import { DataTable, type Column } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { friendlyError } from '@/lib/errors';
import { addDaysTo, fmtDay, fmtTime, toInstant, todayIn } from '@/lib/format';
import { useStaffList } from '@/lib/queries';

interface Block { id: string; staffId: string; staffName: string; startAt: string; endAt: string; reason: string }

/** Time when someone cannot take customers although they are at work (training, a delivery, personal errands). */
export function TimeBlocksPanel() {
  const schedule = useCan()('staff.schedule');
  const client = useQueryClient();
  const { branchId, branch, timezone } = useBranch();
  const today = todayIn(timezone);
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: ['staff-time-blocks', branchId, today], queryFn: () => api.get<Block[]>('/staff-time-blocks', { branchId, from: today, to: addDaysTo(today, 60) }) });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/staff-time-blocks/${id}`),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['staff-time-blocks'] }); void client.invalidateQueries({ queryKey: ['calendar'] }); void client.invalidateQueries({ queryKey: ['availability'] }); toast.success('Time is free again'); },
    onError: toastError,
  });
  const columns: Array<Column<Block>> = [
    { key: 'staff', header: 'Team member', mobile: 'title', cell: (b) => <span className="font-medium">{b.staffName}</span> },
    { key: 'when', header: 'When', cell: (b) => `${fmtDay(b.startAt, timezone, true)}, ${fmtTime(b.startAt, timezone)} – ${fmtTime(b.endAt, timezone)}` },
    { key: 'reason', header: 'Reason', cell: (b) => b.reason },
    { key: 'x', header: 'Remove', srOnlyHeader: true, align: 'right', mobile: 'meta', cell: (b) => schedule && <IconButton label={`Unblock ${b.staffName} at ${fmtTime(b.startAt, timezone)}`} size="sm" onClick={() => remove.mutate(b.id)}><Trash2 className="size-4" /></IconButton> },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted">Blocked time at {branch.name} over the next two months.</p>{schedule && <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Block time</Button>}</div>
      <Card padded={false}>
        {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} compact /> : <DataTable columns={columns} rows={q.data} loading={q.isLoading} rowKey={(b) => b.id} empty={<EmptyState title="Nothing blocked" description="Block time for training, deliveries or errands so nobody can book it." />} />}
      </Card>
      {adding && <BlockTime onClose={() => setAdding(false)} />}
    </div>
  );
}

function BlockTime({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const { branchId, timezone } = useBranch();
  const staff = useStaffList(branchId);
  const [v, setV] = useState({ staffId: '', date: todayIn(timezone), start: '14:00', end: '15:00', reason: '' });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      if (!v.staffId) throw new Error('Choose a team member.');
      if (v.end <= v.start) throw new Error('The end time must be after the start time.');
      return api.post('/staff-time-blocks', { staffId: v.staffId, startAt: toInstant(v.date, v.start, timezone), endAt: toInstant(v.date, v.end, timezone), reason: v.reason.trim() });
    },
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['staff-time-blocks'] }); void client.invalidateQueries({ queryKey: ['calendar'] }); void client.invalidateQueries({ queryKey: ['availability'] }); toast.success('Time blocked'); onClose(); },
    onError: (e) => setError(friendlyError(e).message),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Block time" size="sm" footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate()}>Block time</Button></>}>
      <div className="space-y-4">
        <FormError message={error} />
        <Field label="Team member" required><Select value={v.staffId} onChange={(e) => { setV({ ...v, staffId: e.target.value }); setError(null); }}><option value="">Choose…</option>{(staff.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.displayName}</option>)}</Select></Field>
        <Field label="Date" required><DateInput value={v.date} min={todayIn(timezone)} onChange={(e) => setV({ ...v, date: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="From" required><TimeInput value={v.start} onChange={(e) => setV({ ...v, start: e.target.value })} /></Field><Field label="Until" required><TimeInput value={v.end} onChange={(e) => setV({ ...v, end: e.target.value })} /></Field></div>
        <Field label="Reason" required hint="Shown on the calendar, e.g. “Supplier meeting”."><Input value={v.reason} onChange={(e) => { setV({ ...v, reason: e.target.value }); setError(null); }} /></Field>
      </div>
    </Modal>
  );
}
