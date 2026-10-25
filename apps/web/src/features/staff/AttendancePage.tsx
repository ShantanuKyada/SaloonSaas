import { ATTENDANCE_STATUSES, ATTENDANCE_STATUS_LABELS, attendanceOverrideSchema, manualPunchSchema, type AttendanceDayDto } from '@salon/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Fingerprint, Pencil, Plus, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { toastError } from '@/app/providers';
import { AttendanceBadge } from '@/components/common/badges';
import { Button, IconButton } from '@/components/ui/button';
import { Badge, Card, CardHeader, EmptyState, ErrorState, InlineNotice, PageHeader, Skeleton, StatCard } from '@/components/ui/display';
import { DateInput, Field, FormError, Input, Segmented, Select, TimeInput } from '@/components/ui/form';
import { Modal } from '@/components/ui/overlay';
import { DataTable, type Column } from '@/components/ui/table';
import { api, ApiError } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { friendlyError } from '@/lib/errors';
import { addDaysTo, fmtDateTime, fmtDay, fmtHours, fmtTime, startOfMonth, toInstant, todayIn } from '@/lib/format';
import { useStaffList } from '@/lib/queries';

interface DayData {
  date: string;
  tracked: boolean;
  summary: { present: number; late: number; absent: number; onLeave: number; missingPunch: number; notStarted: number; off: number };
  rows: AttendanceDayDto[];
  integrations: Array<{ id: string; displayName: string; provider: string; status: string; lastSyncAt: string | null; lastSuccessAt: string | null; lastError: string | null }>;
  unmappedPunches: number;
}

export function Component() {
  const manage = useCan()('attendance.manage');
  const client = useQueryClient();
  const { branchId, branch, timezone } = useBranch();
  const today = todayIn(timezone);
  const [mode, setMode] = useState<'day' | 'range'>('day');
  const [date, setDate] = useState(today);
  const [from, setFrom] = useState(startOfMonth(today));
  const [to, setTo] = useState(today);
  const [staffId, setStaffId] = useState('');
  const [punching, setPunching] = useState<AttendanceDayDto | 'new' | null>(null);
  const [correcting, setCorrecting] = useState<AttendanceDayDto | null>(null);
  const staff = useStaffList(branchId, { bookableOnly: false });

  const day = useQuery({ queryKey: ['attendance', 'day', branchId, date], queryFn: () => api.get<DayData>('/attendance/day', { branchId, date }), enabled: mode === 'day', refetchInterval: date === today ? 60_000 : false });
  const range = useQuery({ queryKey: ['attendance', 'range', branchId, from, to, staffId], queryFn: () => api.get<AttendanceDayDto[]>('/attendance', { branchId, from, to, staffId: staffId || undefined }), enabled: mode === 'range' });
  const sync = useMutation({
    mutationFn: () => api.post<{ anyFailed: boolean }>('/attendance/sync'),
    onSuccess: (r) => { void client.invalidateQueries({ queryKey: ['attendance'] }); if (r.anyFailed) toast.warning('The attendance machine could not be reached. Punches will be picked up when it is back.'); else toast.success('Attendance is up to date'); },
    onError: toastError,
  });

  const columns = (withDate: boolean): Array<Column<AttendanceDayDto>> => [
    ...(withDate ? [{ key: 'date', header: 'Date', cell: (r: AttendanceDayDto) => fmtDay(r.date, timezone, true) }] : []),
    { key: 'name', header: 'Team member', mobile: 'title', cell: (r) => <span className="font-medium">{r.staffName}</span> },
    { key: 'status', header: 'Status', cell: (r) => <span className="inline-flex flex-wrap items-center gap-1.5"><AttendanceBadge status={r.status} />{r.isManualOverride && <Badge tone="info">Corrected</Badge>}</span> },
    { key: 'in', header: 'In', cell: (r) => (r.firstIn ? fmtTime(r.firstIn, timezone) : '—') },
    { key: 'out', header: 'Out', cell: (r) => (r.lastOut && r.lastOut !== r.firstIn ? fmtTime(r.lastOut, timezone) : '—') },
    { key: 'late', header: 'Late by', hideBelow: 'md', cell: (r) => (r.lateMinutes > 0 ? `${r.lateMinutes} min` : '—') },
    { key: 'worked', header: 'Worked', hideBelow: 'md', cell: (r) => (r.workedMinutes > 0 ? fmtHours(r.workedMinutes) : '—') },
    { key: 'note', header: 'Note', hideBelow: 'lg', cell: (r) => <span className="text-muted">{r.overrideReason ?? ''}</span> },
    { key: 'actions', header: 'Fix', srOnlyHeader: true, align: 'right', mobile: 'meta', cell: (r) => manage && <span className="flex justify-end gap-1"><IconButton label={`Add a punch for ${r.staffName}`} size="sm" onClick={() => setPunching(r)}><Fingerprint className="size-4" /></IconButton><IconButton label={`Correct status for ${r.staffName}`} size="sm" onClick={() => setCorrecting(r)}><Pencil className="size-4" /></IconButton></span> },
  ];

  const d = day.data;
  return (
    <div className="space-y-5">
      <PageHeader title="Attendance" description={`${branch.name} · who came in, when, and who is away.`} actions={manage && <><Button variant="outline" icon={<Plus className="size-4" />} onClick={() => setPunching('new')}>Add missing punch</Button><Button variant="outline" icon={<RefreshCw className="size-4" />} loading={sync.isPending} onClick={() => sync.mutate()}>Sync machine</Button></>} />
      <div className="flex flex-wrap items-end gap-3">
        <Segmented label="View" value={mode} onChange={setMode} options={[{ value: 'day', label: 'One day' }, { value: 'range', label: 'Date range' }]} />
        {mode === 'day' ? (
          <div className="flex items-center gap-1">
            <IconButton label="Previous day" onClick={() => setDate(addDaysTo(date, -1))}><ChevronLeft className="size-5" /></IconButton>
            <DateInput aria-label="Date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} className="w-44" />
            <IconButton label="Next day" disabled={date >= today} onClick={() => setDate(addDaysTo(date, 1))}><ChevronRight className="size-5" /></IconButton>
            {date !== today && <Button variant="ghost" size="sm" onClick={() => setDate(today)}>Today</Button>}
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <Field label="From"><DateInput value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className="w-44" /></Field>
            <Field label="To"><DateInput value={to} min={from} max={today} onChange={(e) => e.target.value && setTo(e.target.value)} className="w-44" /></Field>
            <Field label="Team member"><Select value={staffId} onChange={(e) => setStaffId(e.target.value)} className="w-48"><option value="">Everyone</option>{(staff.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.displayName}</option>)}</Select></Field>
          </div>
        )}
      </div>

      {mode === 'day' && (
        <>
          {day.isLoading && <div role="status" aria-label="Loading attendance" className="grid grid-cols-2 gap-3 lg:grid-cols-5"><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div>}
          {day.isError && <ErrorState error={day.error} onRetry={() => void day.refetch()} />}
          {d && !d.tracked && <InlineNotice tone="info" title="Attendance is not being tracked here yet">Connect an attendance machine under Settings → Connections, or add punches by hand. Until then everyone is shown as “Not in yet”.</InlineNotice>}
          {d && d.unmappedPunches > 0 && manage && <InlineNotice tone="warning" title={`${d.unmappedPunches} punches from the machine have no matching team member`}>Enter each person’s Biometric ID on their profile. Past punches are matched automatically.</InlineNotice>}
          {d?.integrations.some((i) => i.lastError) && <InlineNotice tone="warning" title="The attendance machine had a problem">{d.integrations.filter((i) => i.lastError).map((i) => `${i.displayName}: ${i.lastError}`).join(' · ')}. Everything else keeps working.</InlineNotice>}
          {d && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <StatCard label="In today" value={d.summary.present} tone="success" />
              <StatCard label="Late" value={d.summary.late} tone={d.summary.late ? 'warning' : 'neutral'} />
              <StatCard label="Absent" value={d.summary.absent} tone={d.summary.absent ? 'danger' : 'neutral'} />
              <StatCard label="On leave" value={d.summary.onLeave} />
              <StatCard label="Needs a look" value={d.summary.missingPunch} hint="Punched in, never out" tone={d.summary.missingPunch ? 'warning' : 'neutral'} />
            </div>
          )}
          {d && (
            <Card padded={false}>
              <DataTable columns={columns(false)} rows={d.rows} rowKey={(r) => r.staffId} empty={<EmptyState title="Nothing recorded for this day" description="Weekly offs, holidays and future days have no attendance." />} />
            </Card>
          )}
          {d && d.integrations.length > 0 && (
            <Card>
              <CardHeader title="Attendance machines" />
              <ul className="divide-y divide-line text-sm">
                {d.integrations.map((i) => <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2"><span className="font-medium">{i.displayName}</span><span className="text-muted">{i.lastSuccessAt ? `Last updated ${fmtDateTime(i.lastSuccessAt, timezone)}` : 'Not synced yet'}</span><Badge tone={i.lastError ? 'warning' : 'success'}>{i.lastError ? 'Problem' : 'Working'}</Badge></li>)}
              </ul>
            </Card>
          )}
        </>
      )}

      {mode === 'range' && (
        <Card padded={false}>
          {range.isError ? <ErrorState error={range.error} onRetry={() => void range.refetch()} compact /> : <DataTable columns={columns(true)} rows={range.data} loading={range.isLoading} rowKey={(r) => `${r.staffId}${r.date}`} empty={<EmptyState title="No attendance in this period" description="Try a wider date range." />} />}
        </Card>
      )}

      {punching && <PunchModal target={punching === 'new' ? null : punching} date={date} onClose={() => setPunching(null)} />}
      {correcting && <CorrectModal row={correcting} onClose={() => setCorrecting(null)} />}
    </div>
  );
}

function PunchModal({ target, date, onClose }: { target: AttendanceDayDto | null; date: string; onClose: () => void }) {
  const client = useQueryClient();
  const { branchId, timezone } = useBranch();
  const staff = useStaffList(branchId, { bookableOnly: false });
  const [v, setV] = useState({ staffId: target?.staffId ?? '', date: target?.date ?? date, time: '19:00', direction: target?.firstIn ? 'out' : 'in', reason: '' });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const parsed = manualPunchSchema.safeParse({ staffId: v.staffId, punchedAt: toInstant(v.date, v.time, timezone), direction: v.direction, reason: v.reason });
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.path[0] === 'reason' ? 'Please say why you are adding this punch.' : v.staffId ? 'Check the date and time.' : 'Choose a team member.');
      return api.post('/attendance/punches', parsed.data);
    },
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['attendance'] }); toast.success('Punch added'); onClose(); },
    onError: (e) => setError(e instanceof Error && !(e instanceof ApiError) ? e.message : friendlyError(e).message),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Add a missing punch" description="Use this when someone forgot to punch. It is recorded with your name and reason." size="sm" footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate()}>Add punch</Button></>}>
      <div className="space-y-4">
        <FormError message={error} />
        <Field label="Team member" required><Select value={v.staffId} disabled={!!target} onChange={(e) => { setV({ ...v, staffId: e.target.value }); setError(null); }}><option value="">Choose…</option>{(staff.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.displayName}</option>)}</Select></Field>
        <Segmented label="Punch" value={v.direction as 'in' | 'out'} onChange={(direction) => setV({ ...v, direction })} options={[{ value: 'in', label: 'Came in' }, { value: 'out', label: 'Went out' }]} />
        <div className="grid grid-cols-2 gap-3"><Field label="Date"><DateInput value={v.date} max={todayIn(timezone)} onChange={(e) => setV({ ...v, date: e.target.value })} /></Field><Field label="Time"><TimeInput value={v.time} onChange={(e) => setV({ ...v, time: e.target.value })} /></Field></div>
        <Field label="Why?" required><Input value={v.reason} placeholder="e.g. Forgot to punch out" onChange={(e) => { setV({ ...v, reason: e.target.value }); setError(null); }} /></Field>
      </div>
    </Modal>
  );
}

function CorrectModal({ row, onClose }: { row: AttendanceDayDto; onClose: () => void }) {
  const client = useQueryClient();
  const { timezone } = useBranch();
  const [status, setStatus] = useState(row.status);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const parsed = attendanceOverrideSchema.safeParse({ staffId: row.staffId, date: row.date, status, reason });
      if (!parsed.success) throw new Error('Please say why you are correcting this day.');
      return api.post('/attendance/override', parsed.data);
    },
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['attendance'] }); toast.success('Attendance corrected'); onClose(); },
    onError: (e) => setError(e instanceof Error && !(e instanceof ApiError) ? e.message : friendlyError(e).message),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Correct ${row.staffName}’s day`} description={fmtDay(row.date, timezone, true)} size="sm" footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate()}>Save correction</Button></>}>
      <div className="space-y-4">
        <FormError message={error} />
        <Field label="Status for this day"><Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>{ATTENDANCE_STATUSES.filter((s) => s !== 'not_started').map((s) => <option key={s} value={s}>{ATTENDANCE_STATUS_LABELS[s]}</option>)}</Select></Field>
        <Field label="Why?" required><Input value={reason} placeholder="e.g. Machine was down" onChange={(e) => { setReason(e.target.value); setError(null); }} /></Field>
        <p className="text-xs text-muted">The change is recorded in the activity log with your name.</p>
      </div>
    </Modal>
  );
}
