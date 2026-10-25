import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Card, EmptyState, InlineNotice, PageHeader } from '@/components/ui/display';
import { DateInput, Field, SearchInput, Select } from '@/components/ui/form';
import { Drawer } from '@/components/ui/overlay';
import { DataTable, type Column } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useBranch } from '@/lib/branch';
import { fmtDateTime } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';

interface LogRow { id: string; createdAt: string; action: string; entityType: string; entityId: string | null; summary: string | null; oldValues: Record<string, unknown> | null; newValues: Record<string, unknown> | null; ip: string | null; userAgent: string | null; userName: string | null }

const AREAS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Everything' },
  { value: 'appointment', label: 'Appointments' },
  { value: 'invoice', label: 'Bills' },
  { value: 'payment', label: 'Payments' },
  { value: 'customer', label: 'Customers' },
  { value: 'staff', label: 'Team and schedules' },
  { value: 'attendance_day', label: 'Attendance' },
  { value: 'service', label: 'Services and prices' },
  { value: 'offer', label: 'Offers' },
  { value: 'package', label: 'Packages' },
  { value: 'user', label: 'Users' },
  { value: 'role', label: 'Roles and permissions' },
  { value: 'branch', label: 'Branches' },
  { value: 'organization', label: 'Salon settings' },
  { value: 'integration', label: 'Connections' },
  { value: 'campaign', label: 'Campaigns' },
  { value: 'report', label: 'Reports downloaded' },
];

const humanise = (action: string) => {
  const text = action.replace(/[._]/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};
const label = (key: string) => key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
const show = (value: unknown): string => (value === null || value === undefined || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value));
const REDACTED = new Set(['passwordHash', 'secretsEncrypted', 'webhookSecret', 'tokenHash']);

/** Who did what, when. Built for the owner’s “what happened to this bill?” question. */
export function Component() {
  const { timezone } = useBranch();
  const [area, setArea] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<LogRow | null>(null);
  const term = useDebounced(search);
  const q = useQuery({ queryKey: ['audit', area, from, to, term, page], queryFn: () => api.list<LogRow>('/audit', { entityType: area || undefined, from: from || undefined, to: to || undefined, search: term || undefined, page, pageSize: 30 }), placeholderData: (p) => p });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  const columns: Array<Column<LogRow>> = [
    { key: 'when', header: 'When', cell: (r) => <span className="whitespace-nowrap">{fmtDateTime(r.createdAt, timezone)}</span> },
    { key: 'who', header: 'Who', mobile: 'title', cell: (r) => r.userName ?? <span className="text-muted">System</span> },
    { key: 'what', header: 'What happened', cell: (r) => <span>{r.summary ?? humanise(r.action)}</span> },
    { key: 'area', header: 'Area', hideBelow: 'md', cell: (r) => <Badge>{AREAS.find((a) => a.value === r.entityType)?.label ?? humanise(r.entityType)}</Badge> },
  ];

  const keys = open ? [...new Set([...Object.keys(open.oldValues ?? {}), ...Object.keys(open.newValues ?? {})])].filter((k) => !REDACTED.has(k)) : [];
  const changed = keys.filter((k) => show(open?.oldValues?.[k]) !== show(open?.newValues?.[k]));

  return (
    <div className="space-y-4">
      <PageHeader title="Activity log" description="A permanent record of changes made in the salon. Entries cannot be edited or removed." />
      <Card padded={false}>
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
          <SearchInput value={search} onChange={reset(setSearch)} placeholder="Search what happened" className="w-full sm:w-64" aria-label="Search activity" />
          <Select aria-label="Area" value={area} onChange={(e) => reset(setArea)(e.target.value)} className="w-52">{AREAS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}</Select>
          <Field label="From" className="w-40"><DateInput value={from} onChange={(e) => reset(setFrom)(e.target.value)} /></Field>
          <Field label="To" className="w-40"><DateInput value={to} min={from} onChange={(e) => reset(setTo)(e.target.value)} /></Field>
        </div>
        <DataTable columns={columns} rows={q.data?.rows} loading={q.isLoading} error={q.isError ? q.error : undefined} onRetry={() => void q.refetch()} rowKey={(r) => r.id} onRowClick={setOpen} pagination={{ page, pageSize: 30, total: q.data?.meta.total ?? 0, onPageChange: setPage }} empty={<EmptyState title="No activity found" description="Try a different area or a wider date range." />} />
      </Card>
      {open && (
        <Drawer open onOpenChange={(o) => !o && setOpen(null)} title={open.summary ?? humanise(open.action)} description={`${open.userName ?? 'System'} · ${fmtDateTime(open.createdAt, timezone)}`}>
          <div className="space-y-4">
            <dl className="divide-y divide-line text-sm">
              <div className="flex justify-between gap-4 py-2"><dt className="text-muted">Action</dt><dd className="font-mono text-xs">{open.action}</dd></div>
              {open.entityId && <div className="flex justify-between gap-4 py-2"><dt className="text-muted">Record</dt><dd className="break-all font-mono text-xs">{open.entityType} · {open.entityId}</dd></div>}
              {open.ip && <div className="flex justify-between gap-4 py-2"><dt className="text-muted">From</dt><dd>{open.ip}</dd></div>}
            </dl>
            {changed.length > 0 ? (
              <div>
                <p className="mb-2 text-sm font-semibold">What changed</p>
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted"><th className="py-1.5 font-medium">Detail</th><th className="py-1.5 font-medium">Before</th><th className="py-1.5 font-medium">After</th></tr></thead>
                  <tbody>{changed.map((k) => <tr key={k} className="border-b border-line last:border-0 align-top"><td className="py-1.5 pr-3 font-medium">{label(k)}</td><td className="break-all py-1.5 pr-3 text-muted">{show(open.oldValues?.[k])}</td><td className="break-all py-1.5">{show(open.newValues?.[k])}</td></tr>)}</tbody>
                </table>
              </div>
            ) : <InlineNotice tone="info">No before-and-after details were recorded for this entry.</InlineNotice>}
          </div>
        </Drawer>
      )}
    </div>
  );
}
