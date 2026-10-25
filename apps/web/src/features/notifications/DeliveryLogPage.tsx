import { NOTIFICATION_CHANNELS, NOTIFICATION_CHANNEL_LABELS, NOTIFICATION_EVENT_LABELS, NOTIFICATION_EVENT_TYPES, type NotificationEventType, type NotificationLogItem, type NotificationStatus } from '@salon/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCw, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { toastError } from '@/app/providers';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, InlineNotice, PageHeader, StatCard, type Tone } from '@/components/ui/display';
import { DateInput, Field, SearchInput, Select } from '@/components/ui/form';
import { Drawer } from '@/components/ui/overlay';
import { DataTable, type Column } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { fmtDateTime } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';

const STATUS: Record<NotificationStatus, { label: string; tone: Tone }> = {
  queued: { label: 'Waiting to send', tone: 'info' },
  processing: { label: 'Sending', tone: 'info' },
  sent: { label: 'Sent', tone: 'primary' },
  delivered: { label: 'Delivered', tone: 'success' },
  read: { label: 'Read', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  skipped: { label: 'Not sent', tone: 'warning' },
};
const GROUPS: Record<string, { label: string; statuses: NotificationStatus[] }> = {
  all: { label: 'Every status', statuses: [] },
  failed: { label: 'Failed', statuses: ['failed'] },
  waiting: { label: 'Waiting to send', statuses: ['queued', 'processing'] },
  ok: { label: 'Sent, delivered or read', statuses: ['sent', 'delivered', 'read'] },
  other: { label: 'Cancelled or not sent', statuses: ['cancelled', 'skipped'] },
};
interface Summary { last7Days: Record<string, number>; connectedChannels: string[]; mode: 'console' | 'live' | 'disabled' }

export function Component() {
  const manage = useCan()('notifications.manage');
  const client = useQueryClient();
  const { timezone } = useBranch();
  const [group, setGroup] = useState('all');
  const [channel, setChannel] = useState('');
  const [eventType, setEventType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<NotificationLogItem | null>(null);
  const term = useDebounced(search);
  const summary = useQuery({ queryKey: ['notifications', 'summary'], queryFn: () => api.get<Summary>('/notifications/summary'), refetchInterval: 30_000 });
  const q = useQuery({
    queryKey: ['notifications', 'list', group, channel, eventType, from, to, term, page],
    queryFn: () => api.list<NotificationLogItem>('/notifications', { status: GROUPS[group]!.statuses, channel: channel || undefined, eventType: eventType || undefined, from: from || undefined, to: to || undefined, search: term || undefined, page, pageSize: 25 }),
    placeholderData: (p) => p,
    refetchInterval: 20_000,
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'retry' | 'cancel' }) => api.post(`/notifications/${id}/${action}`),
    onSuccess: (_d, v) => { void client.invalidateQueries({ queryKey: ['notifications'] }); toast.success(v.action === 'retry' ? 'We will try this message again' : 'Message cancelled'); setOpen(null); },
    onError: toastError,
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };
  const s7 = summary.data?.last7Days ?? {};
  const count = (...k: string[]) => k.reduce((a, x) => a + (s7[x] ?? 0), 0);

  const columns: Array<Column<NotificationLogItem>> = [
    { key: 'when', header: 'When', cell: (n) => <span className="whitespace-nowrap">{fmtDateTime(n.createdAt, timezone)}</span> },
    { key: 'who', header: 'Customer', mobile: 'title', cell: (n) => <div><p className="font-medium">{n.customerName ?? 'Unknown'}</p><p className="text-xs text-muted">{n.recipient}</p></div> },
    { key: 'type', header: 'Message', hideBelow: 'md', cell: (n) => NOTIFICATION_EVENT_LABELS[n.eventType as NotificationEventType] ?? n.eventType },
    { key: 'channel', header: 'Sent by', hideBelow: 'md', cell: (n) => NOTIFICATION_CHANNEL_LABELS[n.channel] },
    { key: 'status', header: 'Status', cell: (n) => <Badge tone={STATUS[n.status].tone}>{STATUS[n.status].label}</Badge> },
    { key: 'why', header: 'Details', hideBelow: 'lg', cell: (n) => <span className="line-clamp-1 text-muted">{n.lastError ?? n.statusReason ?? ''}</span> },
  ];

  return (
    <div className="space-y-5">
      <PageHeader title="Message delivery" description="Every message the salon sent or tried to send, and what happened to it." />
      {summary.data?.mode === 'console' && <InlineNotice tone="warning" title="Practice mode">Messages are written to the server log and are not sent to customers. Connect WhatsApp, email or SMS in Settings → Connections to go live.</InlineNotice>}
      {summary.data?.mode === 'disabled' && <InlineNotice tone="danger" title="Messaging is switched off">No messages are being sent from this environment.</InlineNotice>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Delivered (7 days)" value={count('delivered', 'read')} tone="success" loading={summary.isLoading} />
        <StatCard label="Sent, awaiting receipt" value={count('sent')} loading={summary.isLoading} />
        <StatCard label="Waiting to send" value={count('queued', 'processing')} loading={summary.isLoading} />
        <StatCard label="Failed" value={count('failed')} tone={count('failed') ? 'danger' : 'neutral'} loading={summary.isLoading} />
      </div>
      <Card padded={false}>
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
          <SearchInput value={search} onChange={reset(setSearch)} placeholder="Customer name or mobile" className="w-full sm:w-64" aria-label="Search messages" />
          <Select aria-label="Status" value={group} onChange={(e) => reset(setGroup)(e.target.value)} className="w-52">{Object.entries(GROUPS).map(([k, g]) => <option key={k} value={k}>{g.label}</option>)}</Select>
          <Select aria-label="Channel" value={channel} onChange={(e) => reset(setChannel)(e.target.value)} className="w-40"><option value="">Any channel</option>{NOTIFICATION_CHANNELS.map((c) => <option key={c} value={c}>{NOTIFICATION_CHANNEL_LABELS[c]}</option>)}</Select>
          <Select aria-label="Message type" value={eventType} onChange={(e) => reset(setEventType)(e.target.value)} className="w-48"><option value="">Any message</option>{NOTIFICATION_EVENT_TYPES.map((t) => <option key={t} value={t}>{NOTIFICATION_EVENT_LABELS[t]}</option>)}</Select>
          <Field label="From" className="w-40"><DateInput value={from} onChange={(e) => reset(setFrom)(e.target.value)} /></Field>
          <Field label="To" className="w-40"><DateInput value={to} min={from} onChange={(e) => reset(setTo)(e.target.value)} /></Field>
        </div>
        <DataTable columns={columns} rows={q.data?.rows} loading={q.isLoading} error={q.isError ? q.error : undefined} onRetry={() => void q.refetch()} rowKey={(n) => n.id} onRowClick={setOpen} pagination={{ page, pageSize: 25, total: q.data?.meta.total ?? 0, onPageChange: setPage }} empty={<EmptyState title="No messages match" description="Messages appear here as soon as the salon sends confirmations, reminders and receipts." />} />
      </Card>
      {open && (
        <Drawer open onOpenChange={(o) => !o && setOpen(null)} title={NOTIFICATION_EVENT_LABELS[open.eventType as NotificationEventType] ?? 'Message'} description={`${open.customerName ?? 'Unknown customer'} · ${NOTIFICATION_CHANNEL_LABELS[open.channel]} · ${open.recipient}`} footer={manage && (open.status === 'failed' || open.status === 'queued') ? <>{open.status === 'queued' && <Button variant="outline" icon={<XCircle className="size-4" />} loading={act.isPending} onClick={() => act.mutate({ id: open.id, action: 'cancel' })}>Cancel message</Button>}{open.status === 'failed' && <Button icon={<RotateCw className="size-4" />} loading={act.isPending} onClick={() => act.mutate({ id: open.id, action: 'retry' })}>Try again</Button>}</> : undefined}>
          <div className="space-y-4">
            <Badge tone={STATUS[open.status].tone}>{STATUS[open.status].label}</Badge>
            {(open.lastError || open.statusReason) && <InlineNotice tone={open.status === 'failed' ? 'danger' : 'info'}>{open.lastError ?? open.statusReason}</InlineNotice>}
            <p className="whitespace-pre-wrap rounded-xl bg-surface-2 p-4 text-sm">{open.body}</p>
            <dl className="divide-y divide-line text-sm">
              {([['Created', open.createdAt], ['Scheduled for', open.scheduledFor], ['Sent', open.sentAt], ['Delivered', open.deliveredAt], ['Read', open.readAt]] as const).map(([label, value]) => value && <div key={label} className="flex justify-between py-2"><dt className="text-muted">{label}</dt><dd>{fmtDateTime(value, timezone)}</dd></div>)}
              <div className="flex justify-between py-2"><dt className="text-muted">Attempts</dt><dd>{open.attempts}</dd></div>
            </dl>
            {open.customerId && <Link className="text-sm font-medium text-primary hover:underline" to={`/customers/${open.customerId}`}>Open customer</Link>}
          </div>
        </Drawer>
      )}
    </div>
  );
}
