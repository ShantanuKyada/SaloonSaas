import { HALF_DAY_OPTIONS, LEAVE_TYPES, leaveSchema, type LeaveStatus } from '@salon/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { toastError } from '@/app/providers';
import { Badge, Card, EmptyState, ErrorState, InlineNotice, type Tone } from '@/components/ui/display';
import { Button } from '@/components/ui/button';
import { DateInput, Field, FormError, Select, Textarea } from '@/components/ui/form';
import { Modal } from '@/components/ui/overlay';
import { DataTable, type Column } from '@/components/ui/table';
import { api, ApiError } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { friendlyError } from '@/lib/errors';
import { addDaysTo, fmtDay, fmtTime, startOfMonth, todayIn } from '@/lib/format';
import { useStaffList } from '@/lib/queries';

interface Leave { id: string; staffId: string; staffName: string; leaveType: string; startDate: string; endDate: string; halfDay: string; reason: string | null; status: LeaveStatus; decidedByName: string | null }
interface Conflict { appointmentId: string; bookingNumber: string; startAt: string; customerName: string; serviceName: string }
interface LeaveResult { leave: Leave; conflicts: Conflict[] }

const TYPE_LABEL: Record<string, string> = { casual: 'Casual leave', sick: 'Sick leave', earned: 'Earned leave', unpaid: 'Unpaid leave', other: 'Other' };
const HALF_LABEL: Record<string, string> = { none: 'Full day', first_half: 'First half', second_half: 'Second half' };
const STATUS: Record<LeaveStatus, { label: string; tone: Tone }> = { pending: { label: 'Waiting for approval', tone: 'warning' }, approved: { label: 'Approved', tone: 'success' }, rejected: { label: 'Declined', tone: 'danger' }, cancelled: { label: 'Cancelled', tone: 'neutral' } };

export function LeavePanel() {
  const can = useCan();
  const schedule = can('staff.schedule');
  const client = useQueryClient();
  const { scopeBranchId, timezone } = useBranch();
  const today = todayIn(timezone);
  const [from] = useState(() => startOfMonth(today));
  const [adding, setAdding] = useState(false);
  const [conflicts, setConflicts] = useState<{ staffName: string; list: Conflict[] } | null>(null);
  const to = addDaysTo(today, 180);
  const q = useQuery({ queryKey: ['staff-leaves', scopeBranchId, from, to], queryFn: () => api.get<Leave[]>('/staff-leaves', { branchId: scopeBranchId, from, to }) });
  const decide = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'approved' | 'rejected' | 'cancelled' }) => api.patch<LeaveResult>(`/staff-leaves/${id}`, { status }),
    onSuccess: (r, v) => {
      void client.invalidateQueries({ queryKey: ['staff-leaves'] });
      void client.invalidateQueries({ queryKey: ['calendar'] });
      void client.invalidateQueries({ queryKey: ['availability'] });
      toast.success(v.status === 'approved' ? 'Leave approved' : v.status === 'rejected' ? 'Leave declined' : 'Leave cancelled');
      if (r.conflicts.length) setConflicts({ staffName: q.data?.find((l) => l.id === v.id)?.staffName ?? 'This team member', list: r.conflicts });
    },
    onError: toastError,
  });

  const columns: Array<Column<Leave>> = [
    { key: 'staff', header: 'Team member', mobile: 'title', cell: (l) => <span className="font-medium">{l.staffName}</span> },
    { key: 'type', header: 'Type', cell: (l) => TYPE_LABEL[l.leaveType] ?? l.leaveType },
    { key: 'dates', header: 'Dates', cell: (l) => <span>{l.startDate === l.endDate ? fmtDay(l.startDate, timezone, true) : `${fmtDay(l.startDate, timezone)} – ${fmtDay(l.endDate, timezone, true)}`}{l.halfDay !== 'none' && <span className="text-muted"> · {HALF_LABEL[l.halfDay]}</span>}</span> },
    { key: 'reason', header: 'Reason', hideBelow: 'lg', cell: (l) => l.reason ?? <span className="text-faint">—</span> },
    { key: 'status', header: 'Status', cell: (l) => <Badge tone={STATUS[l.status].tone}>{STATUS[l.status].label}</Badge> },
    {
      key: 'actions', header: 'Actions', srOnlyHeader: true, align: 'right', mobile: 'meta',
      cell: (l) => schedule && (
        <span className="flex justify-end gap-1.5">
          {l.status === 'pending' && <><Button size="sm" icon={<Check className="size-4" />} onClick={() => decide.mutate({ id: l.id, status: 'approved' })}>Approve</Button><Button size="sm" variant="outline" onClick={() => decide.mutate({ id: l.id, status: 'rejected' })}>Decline</Button></>}
          {l.status === 'approved' && l.endDate >= today && <Button size="sm" variant="ghost" icon={<X className="size-4" />} onClick={() => decide.mutate({ id: l.id, status: 'cancelled' })}>Cancel leave</Button>}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted">Leave this month and the next six months.</p>{schedule && <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Record leave</Button>}</div>
      <Card padded={false}>
        {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} compact /> : <DataTable columns={columns} rows={q.data} loading={q.isLoading} rowKey={(l) => l.id} empty={<EmptyState title="No leave recorded" description="Approved leave blocks the person on the calendar and in online booking." />} />}
      </Card>
      {adding && <RecordLeave onClose={() => setAdding(false)} onRecorded={(r) => { if (r.conflicts.length) setConflicts({ staffName: r.leave.staffName || 'This team member', list: r.conflicts }); }} />}
      {conflicts && (
        <Modal open onOpenChange={(o) => !o && setConflicts(null)} title="Bookings need a new team member" description={`${conflicts.staffName} has ${conflicts.list.length} booking${conflicts.list.length === 1 ? '' : 's'} during this leave. Nothing was changed automatically. Open each one to reassign or reschedule.`} footer={<Button onClick={() => setConflicts(null)}>Done</Button>}>
          <ul className="divide-y divide-line">{conflicts.list.map((c) => <li key={`${c.appointmentId}${c.startAt}`} className="flex items-center justify-between gap-3 py-2.5 text-sm"><span><span className="font-medium">{c.customerName}</span> · {c.serviceName}<br /><span className="text-muted">{fmtDay(c.startAt, timezone, true)} at {fmtTime(c.startAt, timezone)} · {c.bookingNumber}</span></span><Link className="font-medium text-primary hover:underline" to={`/appointments/${c.appointmentId}`}>Open</Link></li>)}</ul>
        </Modal>
      )}
    </div>
  );
}

function RecordLeave({ onClose, onRecorded }: { onClose: () => void; onRecorded: (r: LeaveResult) => void }) {
  const client = useQueryClient();
  const { scopeBranchId, timezone } = useBranch();
  const staff = useStaffList(scopeBranchId);
  const today = todayIn(timezone);
  const [v, setV] = useState({ staffId: '', leaveType: 'casual', startDate: today, endDate: today, halfDay: 'none', reason: '', status: 'approved' });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const set = (patch: Partial<typeof v>) => { setV((x) => ({ ...x, ...patch })); setError(null); setFieldErrors({}); };
  const save = useMutation({
    mutationFn: () => {
      const parsed = leaveSchema.safeParse(v);
      if (!parsed.success) {
        const errs: Record<string, string> = {};
        for (const i of parsed.error.issues) errs[String(i.path[0])] ??= i.message;
        setFieldErrors(errs);
        throw new Error('Please fix the highlighted fields.');
      }
      return api.post<LeaveResult>('/staff-leaves', parsed.data);
    },
    onSuccess: (r) => {
      void client.invalidateQueries({ queryKey: ['staff-leaves'] });
      void client.invalidateQueries({ queryKey: ['calendar'] });
      void client.invalidateQueries({ queryKey: ['availability'] });
      toast.success('Leave recorded');
      onRecorded({ ...r, leave: { ...r.leave, staffName: staff.data?.find((s) => s.id === v.staffId)?.displayName ?? '' } });
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError) for (const [path, message] of Object.entries(e.fieldErrors)) setFieldErrors((x) => ({ ...x, [path]: message }));
      setError(e instanceof Error && !(e instanceof ApiError) ? e.message : friendlyError(e).message);
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Record leave" size="sm" persistent footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate()}>Save leave</Button></>}>
      <div className="space-y-4">
        <FormError message={error} />
        <Field label="Team member" required error={fieldErrors.staffId}><Select value={v.staffId} onChange={(e) => set({ staffId: e.target.value })}><option value="">Choose…</option>{(staff.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.displayName}</option>)}</Select></Field>
        <Field label="Type of leave"><Select value={v.leaveType} onChange={(e) => set({ leaveType: e.target.value })}>{LEAVE_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</Select></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From" required error={fieldErrors.startDate}><DateInput value={v.startDate} onChange={(e) => set({ startDate: e.target.value, endDate: v.endDate < e.target.value ? e.target.value : v.endDate })} /></Field>
          <Field label="To" required error={fieldErrors.endDate}><DateInput value={v.endDate} min={v.startDate} onChange={(e) => set({ endDate: e.target.value })} /></Field>
        </div>
        <Field label="Length" error={fieldErrors.halfDay} hint="Half days apply to a single date."><Select value={v.halfDay} onChange={(e) => set({ halfDay: e.target.value })}>{HALF_DAY_OPTIONS.map((h) => <option key={h} value={h}>{HALF_LABEL[h]}</option>)}</Select></Field>
        <Field label="Reason" optional><Textarea rows={2} value={v.reason} onChange={(e) => set({ reason: e.target.value })} /></Field>
        <Field label="Decision"><Select value={v.status} onChange={(e) => set({ status: e.target.value })}><option value="approved">Approve now</option><option value="pending">Leave waiting for approval</option></Select></Field>
        <InlineNotice tone="info">If the person already has bookings on these dates, we will list them so you can reassign.</InlineNotice>
      </div>
    </Modal>
  );
}
