import type { ChangeRequestDto, LeaveStatus } from '@salon/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CalendarClock, CalendarOff, Check } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { toastError } from '@/app/providers';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardHeader } from '@/components/ui/display';
import { Input } from '@/components/ui/form';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { fmtDay, fmtTime } from '@/lib/format';
import { HALF_DAY_LABEL, LEAVE_TYPE_LABEL } from '@/lib/leave';

interface PendingLeave { id: string; staffName: string; leaveType: string; startDate: string; endDate: string; halfDay: string; reason: string | null; status: LeaveStatus }

/**
 * Requests from team members waiting for an answer, where the front desk already works: time changes for whoever can
 * move bookings, leave for whoever manages schedules. Nothing shows when nothing is waiting.
 */
export function TeamRequests() {
  const can = useCan();
  const { scopeBranchId } = useBranch();
  const canMove = can('appointments.update');
  const canLeave = can('staff.schedule');
  const moves = useQuery({ queryKey: ['change-requests', scopeBranchId], queryFn: () => api.get<ChangeRequestDto[]>('/change-requests', { branchId: scopeBranchId }), enabled: canMove, refetchInterval: 60_000 });
  const leaves = useQuery({ queryKey: ['staff-leaves', 'pending', scopeBranchId], queryFn: () => api.get<PendingLeave[]>('/staff-leaves', { status: 'pending', branchId: scopeBranchId }), enabled: canLeave, refetchInterval: 60_000 });
  const total = (moves.data?.length ?? 0) + (leaves.data?.length ?? 0);
  if (total === 0) return null;
  return (
    <Card>
      <CardHeader title="Requests from the team" description={`${total} waiting for your answer`} />
      <ul className="divide-y divide-line">
        {moves.data?.map((r) => <MoveRequest key={r.id} request={r} />)}
        {leaves.data?.map((l) => <LeaveRequest key={l.id} leave={l} />)}
      </ul>
    </Card>
  );
}

function MoveRequest({ request: r }: { request: ChangeRequestDto }) {
  const client = useQueryClient();
  const { timezone: tz } = useBranch();
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState('');
  const refresh = () => { for (const k of ['change-requests', 'appointments', 'calendar', 'dashboard', 'availability']) void client.invalidateQueries({ queryKey: [k] }); };
  const approve = useMutation({ mutationFn: () => api.post(`/change-requests/${r.id}/approve`, { notifyCustomer: true }), onSuccess: () => { toast.success(`Moved ${r.customerName} to ${fmtDay(r.proposedStartAt, tz)}, ${fmtTime(r.proposedStartAt, tz)}`, { description: 'The customer has been told.' }); refresh(); }, onError: toastError });
  const decline = useMutation({ mutationFn: () => api.post(`/change-requests/${r.id}/decline`, { note: note.trim() || undefined }), onSuccess: () => { toast.success('Request declined'); refresh(); }, onError: toastError });
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <CalendarClock className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1 text-sm">
          <p><span className="font-semibold">{r.staffName}</span> asks to move <span className="font-semibold">{r.customerName}</span> <span className="text-muted">({r.services})</span></p>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-muted">{fmtDay(r.currentStartAt, tz)}, {fmtTime(r.currentStartAt, tz)} <ArrowRight className="size-3.5" aria-label="to" /> <span className="font-medium text-fg">{fmtDay(r.proposedStartAt, tz)}, {fmtTime(r.proposedStartAt, tz)}</span></p>
          {r.reason && <p className="mt-1 text-muted">“{r.reason}”</p>}
        </div>
        {!declining && (
          <div className="flex gap-2">
            <Button size="sm" icon={<Check className="size-4" />} loading={approve.isPending} onClick={() => approve.mutate()}>Approve</Button>
            <Button size="sm" variant="outline" onClick={() => setDeclining(true)}>Decline</Button>
          </div>
        )}
      </div>
      {declining && (
        <div className="flex flex-wrap items-center gap-2 pl-8">
          <Input className="min-w-56 flex-1" placeholder="Why? (optional, shown to the team member)" aria-label={`Why decline ${r.staffName}'s request`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
          <Button size="sm" variant="danger" loading={decline.isPending} onClick={() => decline.mutate()}>Decline request</Button>
          <Button size="sm" variant="ghost" onClick={() => setDeclining(false)}>Back</Button>
        </div>
      )}
    </li>
  );
}

function LeaveRequest({ leave: l }: { leave: PendingLeave }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { timezone: tz } = useBranch();
  const decide = useMutation({
    mutationFn: (status: 'approved' | 'rejected') => api.patch<{ conflicts: unknown[] }>(`/staff-leaves/${l.id}`, { status }),
    onSuccess: (r, status) => {
      for (const k of ['staff-leaves', 'calendar', 'availability', 'dashboard']) void client.invalidateQueries({ queryKey: [k] });
      if (status === 'rejected') toast.success('Leave declined');
      else if (r.conflicts.length) toast.warning(`Leave approved: ${r.conflicts.length} ${r.conflicts.length === 1 ? 'booking needs' : 'bookings need'} someone else`, { action: { label: 'Open calendar', onClick: () => navigate('/appointments/calendar') } });
      else toast.success('Leave approved');
    },
    onError: toastError,
  });
  const dates = l.startDate === l.endDate ? fmtDay(l.startDate, tz, true) : `${fmtDay(l.startDate, tz)} – ${fmtDay(l.endDate, tz, true)}`;
  return (
    <li className="flex flex-wrap items-start gap-3 py-3">
      <CalendarOff className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 flex-1 text-sm">
        <p><span className="font-semibold">{l.staffName}</span> asks for leave <Badge tone="warning">{LEAVE_TYPE_LABEL[l.leaveType] ?? l.leaveType}</Badge></p>
        <p className="mt-0.5 font-medium">{dates}{l.halfDay !== 'none' ? ` · ${HALF_DAY_LABEL[l.halfDay]}` : ''}</p>
        {l.reason && <p className="mt-1 text-muted">“{l.reason}”</p>}
      </div>
      <div className="flex gap-2">
        <Button size="sm" icon={<Check className="size-4" />} loading={decide.isPending && decide.variables === 'approved'} onClick={() => decide.mutate('approved')}>Approve</Button>
        <Button size="sm" variant="outline" loading={decide.isPending && decide.variables === 'rejected'} onClick={() => decide.mutate('rejected')}>Decline</Button>
      </div>
    </li>
  );
}
