import { APPOINTMENT_STATUS_LABELS, APPOINTMENT_STATUSES, type AppointmentDto, type AppointmentStatus } from '@salon/shared';
import { useQuery } from '@tanstack/react-query';
import { CalendarPlus, MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { Money, StatusBadge } from '@/components/common/badges';
import { Button, IconButton } from '@/components/ui/button';
import { Card, EmptyState, PageHeader } from '@/components/ui/display';
import { DateInput, Field, Select, SearchInput, Segmented } from '@/components/ui/form';
import { Menu } from '@/components/ui/overlay';
import { DataTable, type Column } from '@/components/ui/table';
import { useQuickActions } from '@/features/quick/QuickActions';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { addDaysTo, fmtDay, fmtTime, startOfWeek, todayIn } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { useStaffList } from '@/lib/queries';
import { AppointmentDrawer } from './AppointmentDrawer';
import { nextActions, useAppointmentActions } from './actions';

export function Component() {
  const { scopeBranchId, timezone } = useBranch();
  const can = useCan();
  const quick = useQuickActions();
  const navigate = useNavigate();
  const { id: openId } = useParams();
  const [params, setParams] = useSearchParams();
  const today = todayIn(timezone);
  const preset = params.get('range') ?? 'today';
  const from = params.get('from') ?? (preset === 'today' ? today : preset === 'tomorrow' ? addDaysTo(today, 1) : preset === 'week' ? startOfWeek(today) : preset === 'upcoming' ? today : '');
  const to = params.get('to') ?? (preset === 'today' ? today : preset === 'tomorrow' ? addDaysTo(today, 1) : preset === 'week' ? addDaysTo(startOfWeek(today), 6) : preset === 'upcoming' ? addDaysTo(today, 30) : '');
  const status = (params.get('status') ?? '') as AppointmentStatus | '';
  const staffId = params.get('staff') ?? '';
  const page = Number(params.get('page') ?? 1);
  const [text, setText] = useState(params.get('q') ?? '');
  const q = useDebounced(text.trim(), 300);
  const actions = useAppointmentActions(timezone);
  const staff = useStaffList(scopeBranchId, { bookableOnly: false });

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v === null || v === '' ? next.delete(k) : next.set(k, v));
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  const list = useQuery({
    queryKey: ['appointments', 'list', scopeBranchId, from, to, status, staffId, q, page],
    queryFn: () => api.list<AppointmentDto>('/appointments', { branchId: scopeBranchId, from: from || undefined, to: to || undefined, status: status || undefined, staffId: staffId || undefined, search: q || undefined, page, pageSize: 25, sortDir: preset === 'upcoming' || preset === 'tomorrow' ? 'asc' : 'desc' }),
    placeholderData: (prev) => prev,
  });

  const columns: Array<Column<AppointmentDto>> = [
    { key: 'when', header: 'When', mobile: 'title', cell: (a) => <div><p className="font-medium tabular-nums">{a.startAt ? `${fmtDay(a.startAt, timezone)}, ${fmtTime(a.startAt, timezone)}` : 'Waiting'}</p><p className="text-xs text-muted">{a.bookingNumber}</p></div> },
    { key: 'customer', header: 'Customer', cell: (a) => <div><p className="font-medium">{a.customer.fullName}</p><p className="text-xs text-muted">{a.customer.mobile}</p></div> },
    { key: 'services', header: 'Services', hideBelow: 'md', cell: (a) => <span>{a.items.map((i) => i.serviceName).join(', ')}</span> },
    { key: 'team', header: 'Team member', hideBelow: 'lg', cell: (a) => <span>{[...new Set(a.items.map((i) => i.staffName).filter(Boolean))].join(', ') || '—'}</span> },
    { key: 'status', header: 'Status', cell: (a) => <StatusBadge status={a.status} /> },
    { key: 'amount', header: 'Amount', align: 'right', hideBelow: 'lg', cell: (a) => <Money value={a.estimatedAmount} /> },
    {
      key: 'actions',
      header: 'Actions',
      srOnlyHeader: true,
      mobile: 'hide',
      align: 'right',
      cell: (a) => {
        const items = nextActions(a, (p) => can(p), actions);
        return items.length ? (
          <span onClick={(e) => e.stopPropagation()}>
            <Menu label={`Actions for ${a.customer.fullName}`} trigger={<IconButton label="Actions" size="sm"><MoreHorizontal className="size-5" /></IconButton>} items={items.map((i) => ({ label: i.label, onSelect: i.run, tone: i.tone }))} />
          </span>
        ) : null;
      },
    },
  ];

  const presets = [['today', 'Today'], ['tomorrow', 'Tomorrow'], ['week', 'This week'], ['upcoming', 'Next 30 days'], ['all', 'All dates']] as const;

  return (
    <div>
      <PageHeader title="Appointments" description="Everything booked, in one list." actions={can('appointments.create') && <Button icon={<CalendarPlus className="size-4" />} hotkey="N" onClick={() => quick.newAppointment()}>New appointment</Button>} />
      <Card padded={false}>
        <div className="space-y-3 border-b border-line p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented label="Date range" value={(presets.some(([k]) => k === preset) ? preset : 'custom') as string} onChange={(v) => set({ range: v, from: null, to: null })} options={presets.map(([value, label]) => ({ value, label }))} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <SearchInput className="lg:col-span-2" value={text} onChange={(v) => { setText(v); set({ q: v.trim() || null }); }} placeholder="Customer name, mobile or booking number" />
            <Field label="Status" className="sr-only">
              <Select value={status} onChange={(e) => set({ status: e.target.value })}>
                <option value="">All statuses</option>
                {APPOINTMENT_STATUSES.map((s) => <option key={s} value={s}>{APPOINTMENT_STATUS_LABELS[s]}</option>)}
              </Select>
            </Field>
            <Field label="Team member" className="sr-only">
              <Select value={staffId} onChange={(e) => set({ staff: e.target.value })}>
                <option value="">All team members</option>
                {(staff.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.displayName}</option>)}
              </Select>
            </Field>
            {preset === 'all' && <div className="flex gap-2"><DateInput aria-label="From date" value={from} onChange={(e) => set({ from: e.target.value })} /><DateInput aria-label="To date" value={to} onChange={(e) => set({ to: e.target.value })} /></div>}
          </div>
        </div>
        <DataTable
          columns={columns}
          rows={list.data?.rows}
          rowKey={(a) => a.id}
          loading={list.isLoading || list.isFetching}
          loadingLabel="Loading appointments…"
          error={list.isError ? list.error : undefined}
          onRetry={() => void list.refetch()}
          onRowClick={(a) => navigate(`/appointments/${a.id}${params.toString() ? `?${params}` : ''}`)}
          pagination={list.data ? { page, pageSize: 25, total: list.data.meta.total, onPageChange: (p) => set({ page: String(p) }) } : undefined}
          empty={<EmptyState title="No appointments found" description={preset === 'today' ? 'Nothing is booked for today yet. You can create a new appointment or add a walk-in customer.' : 'Try another date range or clear the filters.'} action={can('appointments.create') && <Button onClick={() => quick.newAppointment()}>New appointment</Button>} />}
        />
      </Card>
      {openId && <AppointmentDrawer id={openId} onClose={() => navigate(`/appointments${params.toString() ? `?${params}` : ''}`)} />}
      {actions.dialogs}
    </div>
  );
}
