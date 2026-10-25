import { useQuery } from '@tanstack/react-query';
import { BarChart3, CalendarDays, HandCoins, UserCog, Users, Wallet, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import { Card, EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui/display';
import { api } from '@/lib/api';

interface Group { group: string; reports: Array<{ key: string; title: string; description: string }> }

const ICONS: Record<string, LucideIcon> = { Appointments: CalendarDays, Revenue: Wallet, Customers: Users, 'Pending payments & collections': HandCoins, Staff: UserCog };

/** Every report the signed-in person is allowed to run, grouped the way owners think about the business. */
export function Component() {
  const q = useQuery({ queryKey: ['reports', 'catalogue'], queryFn: () => api.get<Group[]>('/reports'), staleTime: 5 * 60_000 });
  return (
    <div>
      <PageHeader title="Reports" description="Pick a report, choose dates, and view it here or download it for Excel." />
      {q.isLoading && <div role="status" aria-label="Loading reports" className="grid gap-4 md:grid-cols-2"><Skeleton className="h-48" /><Skeleton className="h-48" /></div>}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data?.length === 0 && <Card><EmptyState icon={<BarChart3 className="size-8" />} title="No reports available" description="Ask the owner to give you access to reports." /></Card>}
      <div className="grid gap-4 lg:grid-cols-2">
        {q.data?.map((g) => {
          const Icon = ICONS[g.group] ?? BarChart3;
          return (
            <Card key={g.group} padded={false}>
              <h2 className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-semibold"><Icon className="size-4 text-primary" aria-hidden />{g.group}</h2>
              <ul className="divide-y divide-line">
                {g.reports.map((r) => (
                  <li key={r.key}><Link to={`/reports/${r.key}`} className="block px-4 py-3 hover:bg-surface-2/60 focus-visible:bg-surface-2"><p className="font-medium">{r.title}</p><p className="text-sm text-muted">{r.description}</p></Link></li>
                ))}
              </ul>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
