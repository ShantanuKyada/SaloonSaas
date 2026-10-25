import type { CustomerSearchResult } from '@salon/shared';
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { CalendarPlus, CalendarDays, DoorOpen, FileText, Receipt, Search, UserPlus, Users, Wallet } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { fmtDateTime, relativeDays } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { useQuickActions } from '@/features/quick/QuickActions';
import { Money } from '@/components/common/badges';
import { Badge } from '@/components/ui/display';
import { Button } from '@/components/ui/button';

interface Hit {
  type: string;
  id: string;
  title: string;
  subtitle: string;
  link: string;
}
type Groups = Record<'customers' | 'team' | 'appointments' | 'bills' | 'payments', Hit[]>;

const itemClass = 'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm outline-none data-[selected=true]:bg-surface-2';

/** One box for everything: a phone number brings up the customer, what they usually book, what they owe, and one-click actions. */
export function GlobalSearch({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const can = useCan();
  const { timezone } = useBranch();
  const quick = useQuickActions();
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 200);
  useEffect(() => {
    if (!open) setText('');
  }, [open]);

  const customers = useQuery({
    queryKey: ['customer-search', q],
    queryFn: ({ signal }) => api.get<CustomerSearchResult[]>('/customers/search', { q }, signal),
    enabled: open && q.length >= 1 && can('customers.view'),
    staleTime: 10_000,
  });
  const others = useQuery({
    queryKey: ['global-search', q],
    queryFn: ({ signal }) => api.get<Groups>('/search', { q }, signal),
    enabled: open && q.length >= 2,
    staleTime: 10_000,
  });

  const go = (to: string) => {
    onOpenChange(false);
    navigate(to);
  };
  const looksLikeNewNumber = /^\+?\d[\d\s-]{6,}$/.test(text.trim()) && !customers.isFetching && (customers.data?.length ?? 0) === 0 && q === text.trim();

  const actions: Array<{ label: string; icon: ReactNode; run: () => void; show: boolean; keys: string }> = [
    { label: 'New appointment', icon: <CalendarPlus className="size-4" />, run: () => quick.newAppointment(), show: can('appointments.create'), keys: 'N' },
    { label: 'Walk-in', icon: <DoorOpen className="size-4" />, run: () => quick.walkIn(), show: can('walkins.manage'), keys: 'W' },
    { label: 'Add customer', icon: <UserPlus className="size-4" />, run: () => quick.newCustomer(), show: can('customers.create'), keys: '' },
    { label: 'Create bill', icon: <Receipt className="size-4" />, run: () => navigate('/billing/new'), show: can('billing.create'), keys: 'B' },
    { label: 'Collect payment', icon: <Wallet className="size-4" />, run: () => navigate('/billing/collect'), show: can('payments.collect'), keys: 'P' },
    { label: "Today's schedule", icon: <CalendarDays className="size-4" />, run: () => navigate('/appointments/calendar'), show: can('appointments.view'), keys: '' },
  ];

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45" />
        <Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-[8vh] z-50 w-[calc(100vw-1.5rem)] max-w-2xl -translate-x-1/2 overflow-hidden rounded-2xl border border-line bg-surface shadow-pop outline-none">
          <Dialog.Title className="sr-only">Search</Dialog.Title>
          <Command shouldFilter={false} label="Search customers, bookings and bills" loop>
            <div className="flex items-center gap-2 border-b border-line px-4">
              <Search className="size-5 text-muted" aria-hidden />
              <Command.Input value={text} onValueChange={setText} autoFocus placeholder="Search by name, mobile number or customer code…" className="h-14 flex-1 bg-transparent text-base text-fg placeholder:text-faint focus:outline-none" />
              <kbd className="hidden rounded border border-line px-1.5 py-0.5 text-xs text-muted sm:block">Esc</kbd>
            </div>
            <Command.List className="scroll-thin max-h-[65vh] overflow-y-auto p-2">
              {q.length < 1 && (
                <Command.Group heading={<GroupHeading>Quick actions</GroupHeading>}>
                  {actions
                    .filter((a) => a.show)
                    .map((a) => (
                      <Command.Item key={a.label} value={a.label} onSelect={() => { onOpenChange(false); a.run(); }} className={itemClass}>
                        <span className="grid size-8 place-items-center rounded-lg bg-primary-soft text-primary-soft-fg">{a.icon}</span>
                        <span className="flex-1 font-medium">{a.label}</span>
                        {a.keys && <kbd className="rounded border border-line px-1.5 text-xs text-muted">{a.keys}</kbd>}
                      </Command.Item>
                    ))}
                </Command.Group>
              )}

              {q.length >= 1 && (customers.isFetching || others.isFetching) && !customers.data && <p className="px-3 py-6 text-center text-sm text-muted">Searching…</p>}

              {(customers.data?.length ?? 0) > 0 && (
                <Command.Group heading={<GroupHeading>Customers</GroupHeading>}>
                  {customers.data!.map((c) => (
                    <Command.Item key={c.id} value={`c-${c.id}`} onSelect={() => go(`/customers/${c.id}`)} className="flex flex-col gap-2 rounded-xl px-3 py-3 text-sm outline-none data-[selected=true]:bg-surface-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-fg">{c.fullName}</p>
                          <p className="truncate text-xs text-muted">
                            {c.customerCode} {c.mobile ? `· ${c.mobile}` : ''}
                          </p>
                        </div>
                        {c.outstanding > 0 && (
                          <Badge tone="warning">
                            <Money value={c.outstanding} /> pending
                          </Badge>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                        <span>Last visit: {relativeDays(c.lastVisitAt)}</span>
                        {c.favoriteService && <span>Usually: {c.favoriteService}</span>}
                        {c.upcomingAppointment && <span className="font-medium text-info">Next: {fmtDateTime(c.upcomingAppointment.startAt, timezone)}</span>}
                      </div>
                      <div className="flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
                        {can('appointments.create') && (
                          <Button size="sm" variant="soft" icon={<CalendarPlus className="size-4" />} onClick={() => { onOpenChange(false); quick.newAppointment({ customerId: c.id }); }}>
                            Book appointment
                          </Button>
                        )}
                        <Button size="sm" variant="outline" icon={<Users className="size-4" />} onClick={() => go(`/customers/${c.id}`)}>
                          View history
                        </Button>
                        {can('billing.create') && (
                          <Button size="sm" variant="outline" icon={<Receipt className="size-4" />} onClick={() => go(`/billing/new?customerId=${c.id}`)}>
                            Create bill
                          </Button>
                        )}
                        {can('payments.collect') && c.outstanding > 0 && (
                          <Button size="sm" variant="outline" icon={<Wallet className="size-4" />} onClick={() => go(`/billing/collect?customerId=${c.id}`)}>
                            Collect payment
                          </Button>
                        )}
                      </div>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}

              {looksLikeNewNumber && can('customers.create') && (
                <Command.Group heading={<GroupHeading>No customer with this number</GroupHeading>}>
                  <Command.Item value="add-customer" onSelect={() => { onOpenChange(false); quick.newCustomer({ mobile: text.trim() }); }} className={itemClass}>
                    <span className="grid size-8 place-items-center rounded-lg bg-primary-soft text-primary-soft-fg"><UserPlus className="size-4" /></span>
                    <span className="font-medium">Add {text.trim()} as a new customer</span>
                  </Command.Item>
                </Command.Group>
              )}

              {(others.data?.team?.length ?? 0) > 0 && (
                <Command.Group heading={<GroupHeading>Team</GroupHeading>}>
                  {others.data!.team.map((h) => (
                    <HitItem key={h.id} hit={h} icon={<Users className="size-4" />} go={go} />
                  ))}
                </Command.Group>
              )}
              {(others.data?.appointments?.length ?? 0) > 0 && (
                <Command.Group heading={<GroupHeading>Bookings</GroupHeading>}>
                  {others.data!.appointments.map((h) => (
                    <HitItem key={h.id} hit={h} icon={<CalendarDays className="size-4" />} go={go} />
                  ))}
                </Command.Group>
              )}
              {(others.data?.bills?.length ?? 0) > 0 && (
                <Command.Group heading={<GroupHeading>Bills</GroupHeading>}>
                  {others.data!.bills.map((h) => (
                    <HitItem key={h.id} hit={h} icon={<FileText className="size-4" />} go={go} />
                  ))}
                </Command.Group>
              )}
              {(others.data?.payments?.length ?? 0) > 0 && (
                <Command.Group heading={<GroupHeading>Receipts</GroupHeading>}>
                  {others.data!.payments.map((h) => (
                    <HitItem key={h.id} hit={h} icon={<Wallet className="size-4" />} go={go} />
                  ))}
                </Command.Group>
              )}

              {q.length >= 2 && !customers.isFetching && !others.isFetching && (customers.data?.length ?? 0) === 0 && !looksLikeNewNumber && Object.values(others.data ?? {}).every((g) => g.length === 0) && (
                <div className="px-3 py-8 text-center">
                  <p className="text-sm font-medium text-fg">No results for “{q}”</p>
                  <p className="mt-1 text-sm text-muted">Check the spelling, or try the last few digits of the mobile number.</p>
                  {can('customers.create') && (
                    <Button className="mt-3" size="sm" variant="soft" icon={<UserPlus className="size-4" />} onClick={() => { onOpenChange(false); quick.newCustomer({ name: /\d/.test(q) ? undefined : q }); }}>
                      Add a new customer
                    </Button>
                  )}
                </div>
              )}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function GroupHeading({ children }: { children: ReactNode }) {
  return <span className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{children}</span>;
}

function HitItem({ hit, icon, go }: { hit: Hit; icon: ReactNode; go: (to: string) => void }) {
  return (
    <Command.Item value={`${hit.type}-${hit.id}`} onSelect={() => go(hit.link)} className={itemClass}>
      <span className="grid size-8 place-items-center rounded-lg bg-surface-2 text-muted">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-fg">{hit.title}</span>
        <span className="block truncate text-xs text-muted">{hit.subtitle}</span>
      </span>
    </Command.Item>
  );
}
