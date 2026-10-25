import { EMPLOYMENT_STATUS_LABELS, type StaffListItem } from '@salon/shared';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Avatar, Badge, Card, EmptyState, PageHeader } from '@/components/ui/display';
import { Button } from '@/components/ui/button';
import { SearchInput, Segmented } from '@/components/ui/form';
import { DataTable, type Column } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { useDebounced } from '@/lib/hooks';
import { StaffFormDrawer } from './StaffFormDrawer';

type StatusFilter = 'active' | 'all' | 'inactive';

export function Component() {
  const navigate = useNavigate();
  const manage = useCan()('staff.manage');
  const { scopeBranchId, branches } = useBranch();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('active');
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const term = useDebounced(search);
  const q = useQuery({
    queryKey: ['staff', 'list', scopeBranchId, status, term, page],
    queryFn: () => api.list<StaffListItem>('/staff', { branchId: scopeBranchId, status, search: term || undefined, page, pageSize: 25 }),
    placeholderData: (prev) => prev,
  });
  const rows = q.data?.rows;
  const total = q.data?.meta.total ?? 0;

  const columns: Array<Column<StaffListItem>> = [
    { key: 'name', header: 'Team member', mobile: 'title', cell: (s) => <div className="flex items-center gap-3"><Avatar name={s.displayName} color={s.calendarColor} src={s.photoUrl} /><div className="min-w-0"><p className="truncate font-medium">{s.fullName}</p><p className="truncate text-xs text-muted">{s.designation ?? 'Team member'} · {s.employeeCode}</p></div></div> },
    ...(branches.length > 1 ? [{ key: 'branch', header: 'Branch', hideBelow: 'md' as const, cell: (s: StaffListItem) => s.branchName }] : []),
    { key: 'skills', header: 'Skills', hideBelow: 'lg', cell: (s) => (s.expertise.length ? <span className="flex flex-wrap gap-1">{s.expertise.slice(0, 3).map((e) => <Badge key={e.id}>{e.name}</Badge>)}{s.expertise.length > 3 && <Badge>+{s.expertise.length - 3}</Badge>}</span> : <span className="text-muted">None yet</span>) },
    { key: 'services', header: 'Services', align: 'right', hideBelow: 'md', cell: (s) => (s.serviceCount === 0 && s.isBookable ? <Badge tone="warning">None assigned</Badge> : s.serviceCount) },
    { key: 'calendar', header: 'On calendar', hideBelow: 'lg', cell: (s) => (s.isBookable ? 'Yes' : 'No') },
    { key: 'login', header: 'Sign-in', hideBelow: 'lg', cell: (s) => (s.hasLogin ? <span className="inline-flex items-center gap-1 text-sm"><KeyRound className="size-3.5" aria-hidden />Has access</span> : <span className="text-muted">No login</span>) },
    { key: 'status', header: 'Status', cell: (s) => <Badge tone={s.employmentStatus === 'active' ? 'success' : s.employmentStatus === 'on_notice' ? 'warning' : 'neutral'}>{EMPLOYMENT_STATUS_LABELS[s.employmentStatus]}</Badge> },
  ];

  return (
    <div>
      <PageHeader title="Team members" description="Your stylists, therapists and front-desk staff." actions={manage && <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add team member</Button>} />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search by name, code or mobile" className="w-full sm:w-72" aria-label="Search team members" />
          <Segmented label="Show" size="sm" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[{ value: 'active', label: 'Current' }, { value: 'inactive', label: 'Left' }, { value: 'all', label: 'Everyone' }]} />
        </div>
        <DataTable
          columns={columns}
          rows={rows}
          loading={q.isLoading}
          error={q.isError ? q.error : undefined}
          onRetry={() => void q.refetch()}
          rowKey={(s) => s.id}
          onRowClick={(s) => void navigate(`/staff/${s.id}`)}
          pagination={{ page, pageSize: 25, total, onPageChange: setPage }}
          empty={<EmptyState title={term ? 'No one matches that search' : 'No team members yet'} description={term ? 'Check the spelling or try a mobile number.' : 'Add your team so they can be booked and scheduled.'} action={manage && !term && <Button onClick={() => setAdding(true)}>Add team member</Button>} />}
        />
      </Card>
      {adding && <StaffFormDrawer staff={null} suggestedCode={`EMP${String(total + 1).padStart(3, '0')}`} onClose={() => setAdding(false)} onSaved={(s) => void navigate(`/staff/${s.id}`)} />}
    </div>
  );
}
