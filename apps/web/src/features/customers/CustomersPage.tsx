import type { CustomerListItem } from '@salon/shared';
import { useQuery } from '@tanstack/react-query';
import { Download, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { toastError } from '@/app/providers';
import { PendingChip, useMoney } from '@/components/common/badges';
import { Button } from '@/components/ui/button';
import { Avatar, Badge, Card, EmptyState, PageHeader } from '@/components/ui/display';
import { Checkbox, SearchInput, Segmented } from '@/components/ui/form';
import { DataTable, type Column } from '@/components/ui/table';
import { useQuickActions } from '@/features/quick/QuickActions';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { relativeDays } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';

export function Component() {
  const can = useCan();
  const quick = useQuickActions();
  const navigate = useNavigate();
  const money = useMoney();
  const { scopeBranchId } = useBranch();
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('search') ?? '');
  const search = useDebounced(text.trim(), 300);
  const status = (params.get('status') ?? 'active') as 'active' | 'inactive' | 'archived' | 'all';
  const owing = params.get('owing') === '1';
  const page = Number(params.get('page') ?? 1);
  const sortBy = params.get('sort') ?? 'registered';

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v === null || v === '' ? next.delete(k) : next.set(k, v));
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  const query = { search: search || undefined, status, hasOutstanding: owing ? 'true' : undefined, branchId: scopeBranchId, sortBy, sortDir: sortBy === 'name' ? 'asc' : 'desc', page, pageSize: 25 };
  const list = useQuery({ queryKey: ['customers', 'list', query], queryFn: () => api.list<CustomerListItem>('/customers', query), placeholderData: (prev) => prev });

  const columns: Array<Column<CustomerListItem>> = [
    { key: 'name', header: 'Customer', mobile: 'title', cell: (c) => <div className="flex items-center gap-3"><Avatar name={c.fullName} size="sm" /><div className="min-w-0"><p className="truncate font-medium">{c.fullName}</p><p className="text-xs text-muted">{c.customerCode}{c.tags.includes('VIP') ? ' · VIP' : ''}</p></div></div> },
    { key: 'mobile', header: 'Mobile', cell: (c) => <span className="tabular-nums">{c.mobile ?? '—'}</span> },
    { key: 'last', header: 'Last visit', hideBelow: 'md', cell: (c) => relativeDays(c.lastVisitAt) },
    { key: 'visits', header: 'Visits', align: 'right', hideBelow: 'lg', cell: (c) => c.visitCount },
    { key: 'spend', header: 'Lifetime spend', align: 'right', hideBelow: 'lg', cell: (c) => money(c.lifetimeSpend) },
    { key: 'pending', header: 'Pending', align: 'right', cell: (c) => (c.outstanding > 0 ? <PendingChip amount={c.outstanding} /> : <span className="text-faint">—</span>) },
    { key: 'consent', header: 'Offers', hideBelow: 'lg', cell: (c) => <Badge tone={c.marketingConsent ? 'success' : 'neutral'}>{c.marketingConsent ? 'OK to send' : 'No'}</Badge> },
  ];

  const exportCsv = async () => {
    try {
      await api.download('/customers/export', query, 'customers.csv');
      toast.success('Customer list downloaded');
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div>
      <PageHeader
        title="Customers"
        description="Everyone who has booked, visited or been added."
        actions={
          <>
            {can('customers.export') && <Button variant="outline" icon={<Download className="size-4" />} onClick={() => void exportCsv()}>Export</Button>}
            {can('customers.create') && <Button icon={<UserPlus className="size-4" />} onClick={() => quick.newCustomer()}>Add customer</Button>}
          </>
        }
      />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <SearchInput className="min-w-60 flex-1" value={text} onChange={(v) => { setText(v); set({ search: v.trim() || null }); }} placeholder="Search by name, mobile number or customer code" autoFocus />
          <Segmented label="Show" value={status} onChange={(v) => set({ status: v === 'active' ? null : v })} options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'all', label: 'All' }]} />
          <Checkbox checked={owing} onCheckedChange={(v) => set({ owing: v ? '1' : null })} label="Has pending payment" />
        </div>
        <DataTable
          columns={columns}
          rows={list.data?.rows}
          rowKey={(c) => c.id}
          loading={list.isLoading || list.isFetching}
          loadingLabel="Loading customers…"
          error={list.isError ? list.error : undefined}
          onRetry={() => void list.refetch()}
          onRowClick={(c) => navigate(`/customers/${c.id}`)}
          pagination={list.data ? { page, pageSize: 25, total: list.data.meta.total, onPageChange: (p) => set({ page: String(p) }) } : undefined}
          empty={
            <EmptyState
              title={search ? `No customer matches “${search}”` : 'No customers yet'}
              description={search ? 'Check the spelling, or try the last few digits of the mobile number.' : 'Add your first customer to start booking appointments and bills.'}
              action={can('customers.create') && <Button onClick={() => quick.newCustomer({ name: /^\+?[\d\s-]{3,}$/.test(search) ? undefined : search, mobile: /^\+?[\d\s-]{6,}$/.test(search) ? search : undefined })}>{search ? `Add “${search}”` : 'Add customer'}</Button>}
            />
          }
        />
      </Card>
    </div>
  );
}
