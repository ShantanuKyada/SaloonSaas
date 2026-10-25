import type { Customer360, CustomerSearchResult } from '@salon/shared';
import { useQuery } from '@tanstack/react-query';
import { Phone, UserPlus, X } from 'lucide-react';
import { useState } from 'react';
import { Button, IconButton } from '@/components/ui/button';
import { Avatar, Badge } from '@/components/ui/display';
import { SearchInput } from '@/components/ui/form';
import { useQuickActions } from '@/features/quick/QuickActions';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { fmtDateTime, relativeDays } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { qk } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Money, PendingChip } from './badges';

export interface PickedCustomer {
  id: string;
  fullName: string;
  customerCode: string;
  mobile: string | null;
  outstanding: number;
  creditLimit: number | null;
  preferredStaffId: string | null;
  suggestion: Customer360['suggestion'];
  favoriteServiceId: string | null;
  packages: Customer360['packages'];
}

export function useCustomer360(id: string | null | undefined) {
  return useQuery({ queryKey: qk.customer360(id ?? ''), queryFn: () => api.get<Customer360>(`/customers/${id}/360`), enabled: !!id, staleTime: 15_000 });
}

export function toPicked(c: Customer360): PickedCustomer {
  return {
    id: c.customer.id,
    fullName: c.customer.fullName,
    customerCode: c.customer.customerCode,
    mobile: c.customer.mobile,
    outstanding: c.account.outstanding,
    creditLimit: c.customer.creditLimit,
    preferredStaffId: c.customer.preferredStaffId,
    suggestion: c.suggestion,
    favoriteServiceId: c.stats.favoriteService?.id ?? null,
    packages: c.packages,
  };
}

const WEEKDAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export function habitText(s: NonNullable<Customer360['suggestion']>): string {
  const when = s.weekday ? `${WEEKDAYS[s.weekday]}${s.hour !== null ? (s.hour >= 17 ? ' evenings' : s.hour >= 12 ? ' afternoons' : ' mornings') : 's'}` : '';
  return `Usually ${s.serviceName}${s.staffName ? ` with ${s.staffName}` : ''}${when ? `, ${when}` : ''}`;
}

/**
 * Search → pick → see what matters (last visit, usual booking, pending amount). Used by booking, walk-in and billing so
 * the receptionist always finds customers the same way.
 */
export function CustomerPicker({ value, onChange, autoFocus, label = 'Customer' }: { value: string | null; onChange: (customer: PickedCustomer | null) => void; autoFocus?: boolean; label?: string }) {
  const { timezone } = useBranch();
  const can = useCan();
  const quick = useQuickActions();
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 200);
  const selected = useCustomer360(value);
  const results = useQuery({
    queryKey: ['customer-search', q],
    queryFn: ({ signal }) => api.get<CustomerSearchResult[]>('/customers/search', { q }, signal),
    enabled: !value && q.length >= 1,
    staleTime: 10_000,
  });

  if (value) {
    const c = selected.data;
    return (
      <div className="rounded-xl border border-line bg-surface-2 p-3" aria-live="polite">
        {selected.isError ? (
          <div className="flex items-center justify-between gap-3 text-sm" role="alert">
            <span className="text-danger">We could not load this customer.</span>
            <span className="flex gap-2"><Button size="sm" variant="outline" onClick={() => void selected.refetch()}>Try again</Button><Button size="sm" variant="ghost" onClick={() => onChange(null)}>Choose someone else</Button></span>
          </div>
        ) : !c ? (
          <div role="status" aria-label="Loading customer" className="skeleton h-14" />
        ) : (
          <div className="flex items-start gap-3">
            <Avatar name={c.customer.fullName} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate font-semibold text-fg">{c.customer.fullName}</p>
                <PendingChip amount={c.account.outstanding} />
                {c.account.advance > 0 && <Badge tone="success">Advance <Money value={c.account.advance} /></Badge>}
                {c.customer.tags.includes('VIP') && <Badge tone="primary">VIP</Badge>}
              </div>
              <p className="flex flex-wrap items-center gap-x-3 text-xs text-muted">
                <span>{c.customer.customerCode}</span>
                {c.customer.mobile && (
                  <span className="inline-flex items-center gap-1">
                    <Phone className="size-3" aria-hidden />
                    {c.customer.mobile}
                  </span>
                )}
                <span>Last visit: {relativeDays(c.stats.lastVisitAt)}</span>
              </p>
              {c.suggestion && <p className="mt-1 text-xs font-medium text-primary-soft-fg">{habitText(c.suggestion)}</p>}
              {c.upcoming[0] && <p className="mt-0.5 text-xs text-info">Next booking: {fmtDateTime(c.upcoming[0].startAt, timezone)} · {c.upcoming[0].services}</p>}
            </div>
            <IconButton label={`Change ${label.toLowerCase()}`} size="sm" onClick={() => onChange(null)}>
              <X className="size-4" />
            </IconButton>
          </div>
        )}
      </div>
    );
  }

  const addNew = () =>
    quick.newCustomer({
      name: /^\+?[\d\s-]{3,}$/.test(q) ? undefined : q,
      mobile: /^\+?[\d\s-]{6,}$/.test(q) ? q : undefined,
      onCreated: (id) => void api.get<Customer360>(`/customers/${id}/360`).then((c) => onChange(toPicked(c))),
    });

  return (
    <div className="space-y-2">
      <SearchInput autoFocus={autoFocus} value={text} onChange={setText} placeholder="Name, mobile number or customer code" aria-label={`Find ${label.toLowerCase()}`} />
      {q.length >= 1 && (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          {results.isFetching && !results.data ? (
            <p className="px-3 py-3 text-sm text-muted">Searching…</p>
          ) : (results.data?.length ?? 0) === 0 ? (
            <div className="space-y-2 px-3 py-3 text-sm">
              <p className="text-muted">No customer found for “{q}”.</p>
              {can('customers.create') && (
                <Button size="sm" variant="soft" icon={<UserPlus className="size-4" />} onClick={addNew}>
                  Add “{q}” as a new customer
                </Button>
              )}
            </div>
          ) : (
            <ul>
              {results.data!.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => void api.get<Customer360>(`/customers/${c.id}/360`).then((full) => { setText(''); onChange(toPicked(full)); })}
                    className={cn('flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2 focus-visible:bg-surface-2')}
                  >
                    <Avatar name={c.fullName} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-fg">{c.fullName}</span>
                      <span className="block truncate text-xs text-muted">
                        {c.customerCode} {c.mobile ? `· ${c.mobile}` : ''} · last visit {relativeDays(c.lastVisitAt)}
                        {c.favoriteService ? ` · ${c.favoriteService}` : ''}
                      </span>
                    </span>
                    {c.outstanding > 0 && <PendingChip amount={c.outstanding} />}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {(results.data?.length ?? 0) > 0 && can('customers.create') && (
            <button type="button" onClick={addNew} className="flex w-full items-center gap-2 border-t border-line px-3 py-2.5 text-left text-sm font-medium text-primary hover:bg-surface-2 focus-visible:bg-surface-2">
              <UserPlus className="size-4" aria-hidden />
              Not them? Add “{q}” as a new customer
            </button>
          )}
        </div>
      )}
      {q.length === 0 && can('customers.create') && (
        <button type="button" onClick={() => quick.newCustomer({ onCreated: (id) => void api.get<Customer360>(`/customers/${id}/360`).then((c) => onChange(toPicked(c))) })} className="text-sm font-medium text-primary hover:underline">
          + New customer
        </button>
      )}
    </div>
  );
}
