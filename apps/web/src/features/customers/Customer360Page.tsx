import { NOTIFICATION_CATEGORIES, NOTIFICATION_CATEGORY_LABELS, NOTIFICATION_CHANNELS, NOTIFICATION_CHANNEL_LABELS, PAYMENT_METHOD_LABELS, type Customer360, type NotificationCategory, type NotificationChannel } from '@salon/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, Mail, MessageCircle, Pencil, Phone, Receipt, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { toastError } from '@/app/providers';
import { Money, PaymentBadge, StatusBadge, useMoney } from '@/components/common/badges';
import { useCustomer360 } from '@/components/common/CustomerPicker';
import { Button } from '@/components/ui/button';
import { Avatar, Badge, Card, CardHeader, EmptyState, ErrorState, InlineNotice, PageHeader, Skeleton, StatCard, TabPanel, Tabs } from '@/components/ui/display';
import { Switch } from '@/components/ui/form';
import { DataTable } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { fmtDateTime, fmtDay, relativeDays } from '@/lib/format';
import { useQuickActions } from '@/features/quick/QuickActions';
import CustomerFormModal from './CustomerFormModal';

const WEEKDAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function Component() {
  const { id } = useParams();
  const q = useCustomer360(id);
  const navigate = useNavigate();
  const can = useCan();
  const quick = useQuickActions();
  const money = useMoney();
  const { timezone } = useBranch();
  const [tab, setTab] = useState('overview');
  const [editing, setEditing] = useState(false);

  if (q.isLoading) return <div role="status" aria-label="Loading customer" className="space-y-4"><Skeleton className="h-20" /><div className="grid gap-3 md:grid-cols-4"><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div></div>;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const c = q.data;
  const { customer, stats, account } = c;

  return (
    <div className="space-y-5">
      <PageHeader
        back={<Link to="/customers" className="mb-1 inline-block text-sm text-muted hover:text-fg">← All customers</Link>}
        title={
          <span className="flex flex-wrap items-center gap-3">
            <Avatar name={customer.fullName} size="lg" />
            <span>
              {customer.fullName}
              <span className="block text-sm font-normal text-muted">
                {customer.customerCode}
                {customer.mobile && <span className="ml-3 inline-flex items-center gap-1"><Phone className="size-3.5" aria-hidden />{customer.mobile}</span>}
                {customer.email && <span className="ml-3 inline-flex items-center gap-1"><Mail className="size-3.5" aria-hidden />{customer.email}</span>}
              </span>
            </span>
          </span>
        }
        actions={
          <>
            {can('appointments.create') && <Button icon={<CalendarPlus className="size-4" />} onClick={() => quick.newAppointment({ customerId: customer.id })}>Book appointment</Button>}
            {can('billing.create') && <Button variant="outline" icon={<Receipt className="size-4" />} onClick={() => navigate(`/billing/new?customerId=${customer.id}`)}>Create bill</Button>}
            {can('payments.collect') && account.outstanding > 0 && <Button variant="outline" icon={<Wallet className="size-4" />} onClick={() => navigate(`/billing/collect?customerId=${customer.id}`)}>Collect payment</Button>}
            {can('customers.update') && <Button variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Edit</Button>}
          </>
        }
      />

      <div className="flex flex-wrap gap-2">
        {customer.tags.map((t) => <Badge key={t} tone="primary">{t}</Badge>)}
        {customer.status !== 'active' && <Badge tone="neutral">{customer.status}</Badge>}
        <Badge tone={customer.marketingConsent ? 'success' : 'neutral'}>{customer.marketingConsent ? 'OK to send offers' : 'No offers (no consent)'}</Badge>
        {customer.contactMasked && <Badge tone="warning">Contact details hidden for your role</Badge>}
      </div>

      {account.outstanding > 0 && (
        <InlineNotice tone="warning" title={<span><Money value={account.outstanding} /> pending</span>} action={can('payments.collect') ? <Link to={`/billing/collect?customerId=${customer.id}`} className="text-sm font-semibold underline">Collect payment</Link> : undefined}>
          {account.otherBranchesOutstanding > 0 && <>Includes {money(account.otherBranchesOutstanding)} at branches you cannot see. </>}
          {account.creditLimit !== null && <>Credit limit {money(account.creditLimit)}; {money(account.availableCredit ?? 0)} left.</>}
        </InlineNotice>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-6">
        <StatCard label="Lifetime spend" value={money(stats.lifetimeSpend)} />
        <StatCard label="Visits" value={stats.visitCount} hint={stats.visitsPerMonth ? `${stats.visitsPerMonth} a month` : undefined} />
        <StatCard label="Average visit" value={money(stats.averageVisitValue)} />
        <StatCard label="Last visit" value={relativeDays(stats.lastVisitAt)} hint={stats.lastVisitAt ? fmtDay(stats.lastVisitAt, timezone, true) : undefined} />
        <StatCard label="Favourite service" value={<span className="text-lg">{stats.favoriteService?.name ?? '—'}</span>} />
        <StatCard label="Favourite team member" value={<span className="text-lg">{stats.favoriteStaff?.name ?? '—'}</span>} />
      </div>

      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'visits', label: 'Visits' },
          { value: 'money', label: 'Bills & payments', badge: account.outstanding > 0 ? <Badge tone="warning">{money(account.outstanding)}</Badge> : undefined },
          { value: 'packages', label: 'Packages & offers', badge: c.packages.filter((p) => p.status === 'active').length ? <Badge tone="success">{c.packages.filter((p) => p.status === 'active').length}</Badge> : undefined },
          { value: 'messages', label: 'Messages' },
          { value: 'preferences', label: 'Preferences' },
        ]}
      >
        <TabPanel value="overview" className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader title="Upcoming" />
            {c.upcoming.length === 0 ? <p className="text-sm text-muted">Nothing booked.</p> : (
              <ul className="space-y-2">{c.upcoming.map((a) => <li key={a.id} className="flex items-center justify-between gap-3 text-sm"><span><span className="font-medium">{fmtDateTime(a.startAt, timezone)}</span><span className="block text-muted">{a.services} · {a.staff}</span></span><StatusBadge status={a.status} /></li>)}</ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Usually books" />
            {c.suggestion ? (
              <p className="text-sm"><span className="font-semibold">{c.suggestion.serviceName}</span>{c.suggestion.staffName && <> with <span className="font-semibold">{c.suggestion.staffName}</span></>}{c.suggestion.weekday && <>, usually on {WEEKDAYS[c.suggestion.weekday]}{c.suggestion.hour !== null ? (c.suggestion.hour >= 17 ? ' evenings' : c.suggestion.hour >= 12 ? ' afternoons' : ' mornings') : ''}</>}.</p>
            ) : <p className="text-sm text-muted">Not enough history yet.</p>}
            <h3 className="mb-2 mt-4 text-sm font-semibold">Most frequent services</h3>
            {c.topServices.length === 0 ? <p className="text-sm text-muted">No bills yet.</p> : <ul className="space-y-1.5 text-sm">{c.topServices.map((s) => <li key={s.serviceId} className="flex justify-between"><span>{s.name} <span className="text-muted">×{s.count}</span></span><Money value={s.spend} /></li>)}</ul>}
          </Card>
          <Card>
            <CardHeader title="Team members they have seen" />
            {c.staffUsed.length === 0 ? <p className="text-sm text-muted">No history yet.</p> : <ul className="space-y-1.5 text-sm">{c.staffUsed.map((s) => <li key={s.staffId} className="flex justify-between"><span>{s.name}</span><span className="text-muted">{s.count} services · last {relativeDays(s.lastAt)}</span></li>)}</ul>}
          </Card>
          <Card>
            <CardHeader title="About" />
            <dl className="space-y-1.5 text-sm">
              <Row label="Joined" value={fmtDay(customer.registeredAt, timezone, true)} />
              {customer.dateOfBirth && <Row label="Birthday" value={fmtDay(customer.dateOfBirth, timezone)} />}
              {customer.city && <Row label="City" value={customer.city} />}
              {customer.referredBy && <Row label="Referred by" value={customer.referredBy.fullName} />}
              {stats.cancelledCount + stats.noShowCount > 0 && <Row label="Cancelled / no-shows" value={`${stats.cancelledCount} / ${stats.noShowCount}`} />}
            </dl>
            {customer.notes && <p className="mt-3 whitespace-pre-wrap rounded-lg bg-surface-2 p-3 text-sm">{customer.notes}</p>}
          </Card>
        </TabPanel>

        <TabPanel value="visits">
          <Card padded={false}>
            <DataTable
              rows={c.recentAppointments}
              rowKey={(a) => a.id}
              columns={[
                { key: 'when', header: 'When', mobile: 'title', cell: (a) => fmtDateTime(a.startAt, timezone) },
                { key: 'services', header: 'Services', cell: (a) => a.services },
                { key: 'staff', header: 'Team member', hideBelow: 'md', cell: (a) => a.staff },
                { key: 'branch', header: 'Branch', hideBelow: 'lg', cell: (a) => a.branchName },
                { key: 'status', header: 'Status', cell: (a) => <StatusBadge status={a.status} /> },
              ]}
              empty={<EmptyState title="No visits yet" />}
            />
          </Card>
        </TabPanel>

        <TabPanel value="money" className="space-y-5">
          <Card padded={false}>
            <div className="p-4 pb-0"><CardHeader title="Bills" actions={<Link to={`/billing/ledger?customerId=${customer.id}`} className="text-sm font-medium text-primary hover:underline">Full ledger</Link>} /></div>
            <DataTable
              rows={c.invoices}
              rowKey={(i) => i.id}
              columns={[
                { key: 'no', header: 'Bill', mobile: 'title', cell: (i) => <Link to={`/billing/bills/${i.id}`} className="font-medium text-primary hover:underline">{i.invoiceNumber}</Link> },
                { key: 'date', header: 'Date', cell: (i) => fmtDay(i.invoiceDate, timezone) },
                { key: 'branch', header: 'Branch', hideBelow: 'lg', cell: (i) => i.branchName },
                { key: 'total', header: 'Total', align: 'right', cell: (i) => <Money value={i.grandTotal} /> },
                { key: 'due', header: 'Pending', align: 'right', cell: (i) => (i.balanceDue > 0 ? <Money value={i.balanceDue} className="font-semibold text-warning" /> : <span className="text-faint">—</span>) },
                { key: 'status', header: 'Status', cell: (i) => <PaymentBadge status={i.paymentStatus} /> },
              ]}
              empty={<EmptyState title="No bills yet" />}
            />
          </Card>
          <Card padded={false}>
            <div className="p-4 pb-0"><CardHeader title="Payments" /></div>
            <DataTable
              rows={c.payments}
              rowKey={(p) => p.id}
              columns={[
                { key: 'no', header: 'Receipt', mobile: 'title', cell: (p) => <Link to={`/billing/payments/${p.id}`} className="font-medium text-primary hover:underline">{p.receiptNumber}</Link> },
                { key: 'date', header: 'Received', cell: (p) => fmtDateTime(p.receivedAt, timezone) },
                { key: 'method', header: 'Method', hideBelow: 'md', cell: (p) => PAYMENT_METHOD_LABELS[p.method] },
                { key: 'amount', header: 'Amount', align: 'right', cell: (p) => <Money value={p.amount} /> },
                { key: 'adv', header: 'Kept as advance', align: 'right', hideBelow: 'lg', cell: (p) => (p.unallocatedAmount > 0 ? <Money value={p.unallocatedAmount} /> : '—') },
                { key: 'st', header: 'Status', cell: (p) => (p.status === 'void' ? <Badge tone="neutral">Cancelled</Badge> : <Badge tone="success">Received</Badge>) },
              ]}
              empty={<EmptyState title="No payments yet" />}
            />
          </Card>
        </TabPanel>

        <TabPanel value="packages" className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader title="Packages" />
            {c.packages.length === 0 ? <p className="text-sm text-muted">No packages purchased.</p> : (
              <ul className="space-y-4">
                {c.packages.map((p) => (
                  <li key={p.id}>
                    <div className="flex items-center justify-between"><p className="font-medium">{p.packageName}</p><Badge tone={p.status === 'active' ? 'success' : 'neutral'}>{p.status}</Badge></div>
                    <p className="text-xs text-muted">Bought {fmtDay(p.purchasedAt, timezone, true)} · expires {fmtDay(p.expiresAt, timezone, true)}</p>
                    <ul className="mt-1.5 space-y-0.5 text-sm">{p.items.map((i) => <li key={i.id} className="flex justify-between"><span>{i.serviceName}</span><span className={i.remaining === 0 ? 'text-faint' : 'font-medium'}>{i.remaining} of {i.quantityTotal} left</span></li>)}</ul>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Offers used" />
            {c.offersUsed.length === 0 ? <p className="text-sm text-muted">No offers used yet.</p> : <ul className="space-y-2 text-sm">{c.offersUsed.map((o, i) => <li key={i} className="flex justify-between"><span>{o.name}<span className="block text-xs text-muted">{o.invoiceNumber} · {fmtDay(o.redeemedAt, timezone)}</span></span><span>saved <Money value={o.discount} /></span></li>)}</ul>}
          </Card>
        </TabPanel>

        <TabPanel value="messages">
          <Card padded={false}>
            <DataTable
              rows={c.communications}
              rowKey={(m) => m.id}
              columns={[
                { key: 'when', header: 'When', mobile: 'title', cell: (m) => fmtDateTime(m.createdAt, timezone) },
                { key: 'ch', header: 'Channel', cell: (m) => NOTIFICATION_CHANNEL_LABELS[m.channel] },
                { key: 'what', header: 'Message', cell: (m) => <span className="line-clamp-2 max-w-md text-muted">{m.body}</span> },
                { key: 'st', header: 'Status', cell: (m) => <Badge tone={m.status === 'failed' ? 'danger' : m.status === 'delivered' || m.status === 'read' || m.status === 'sent' ? 'success' : 'neutral'}>{m.status}</Badge> },
              ]}
              empty={<EmptyState title="No messages sent yet" description="Booking confirmations, reminders and receipts will appear here." />}
            />
          </Card>
        </TabPanel>

        <TabPanel value="preferences">
          <Preferences customer360={c} editable={can('customers.update')} />
        </TabPanel>
      </Tabs>
      {editing && <CustomerFormModal customer={customer} onClose={() => setEditing(false)} />}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="flex justify-between gap-4"><dt className="text-muted">{label}</dt><dd className="text-right font-medium">{value}</dd></div>;
}

/** Channel × message-type switches plus marketing consent, with changes recorded and timestamped on the server. */
function Preferences({ customer360: c, editable }: { customer360: Customer360; editable: boolean }) {
  const client = useQueryClient();
  const { timezone } = useBranch();
  const initial = new Map(c.customer.preferences.map((p) => [`${p.channel}:${p.category}`, p.enabled]));
  const isOn = (channel: NotificationChannel, category: NotificationCategory) => initial.get(`${channel}:${category}`) ?? !(channel === 'sms');
  const save = useMutation({
    mutationFn: (body: { marketingConsent?: boolean; preferences: Array<{ channel: NotificationChannel; category: NotificationCategory; enabled: boolean }> }) => api.put(`/customers/${c.customer.id}/preferences`, { ...body, source: 'in_person' }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['customer-360', c.customer.id] }); toast.success('Preferences saved'); },
    onError: toastError,
  });
  return (
    <Card>
      <CardHeader title="How and when to message this customer" description="Booking confirmations and receipts are sent unless switched off here. SMS is off unless you turn it on." />
      <div className="mb-5"><Switch checked={c.customer.marketingConsent} disabled={!editable} onCheckedChange={(v) => save.mutate({ marketingConsent: v, preferences: [] })} label="OK to send offers and promotions" description={c.customer.marketingConsentAt ? `Last changed ${fmtDay(c.customer.marketingConsentAt, timezone, true)}` : 'Needed before any promotional message can be sent.'} /></div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-muted"><th className="py-2 font-medium">Message</th>{NOTIFICATION_CHANNELS.map((ch) => <th key={ch} className="px-3 py-2 text-center font-medium">{NOTIFICATION_CHANNEL_LABELS[ch]}</th>)}</tr></thead>
          <tbody>
            {NOTIFICATION_CATEGORIES.map((cat) => (
              <tr key={cat} className="border-t border-line">
                <td className="py-2.5">{NOTIFICATION_CATEGORY_LABELS[cat]}</td>
                {NOTIFICATION_CHANNELS.map((ch) => (
                  <td key={ch} className="px-3 py-2.5 text-center">
                    <input type="checkbox" className="size-5 accent-[var(--primary)]" disabled={!editable || save.isPending} checked={isOn(ch, cat)} aria-label={`${NOTIFICATION_CATEGORY_LABELS[cat]} by ${NOTIFICATION_CHANNEL_LABELS[ch]}`} onChange={(e) => save.mutate({ preferences: [{ channel: ch, category: cat, enabled: e.target.checked }] })} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-xs text-muted"><MessageCircle className="size-3.5" aria-hidden />Opt-outs are always respected, including for messages already waiting to be sent.</p>
    </Card>
  );
}
