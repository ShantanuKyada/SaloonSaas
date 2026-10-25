import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Avatar, Badge, Card, EmptyState, ErrorState, InlineNotice, PageHeader, Skeleton } from '@/components/ui/display';
import { Checkbox } from '@/components/ui/form';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { friendlyError } from '@/lib/errors';
import { useServices, useStaffList } from '@/lib/queries';
import { staffDetailKey, useStaffDetails, type StaffDetail } from './hooks';

/** One grid showing who can do what. Tick a box to qualify someone; boxes stay locked when the person lacks the skill. */
export function Component() {
  const manage = useCan()('staff.manage');
  const client = useQueryClient();
  const { scopeBranchId, branches } = useBranch();
  const staffQ = useStaffList(scopeBranchId, { bookableOnly: true });
  const servicesQ = useServices(scopeBranchId);
  const { details, loading, error } = useStaffDetails((staffQ.data ?? []).map((s) => s.id));
  const [pending, setPending] = useState<Set<string>>(new Set());
  const staff = details;
  const services = useMemo(() => (servicesQ.data ?? []).filter((s) => s.status === 'active'), [servicesQ.data]);
  const grouped = useMemo(() => {
    const m = new Map<string, typeof services>();
    for (const s of services) m.set(s.categoryName, [...(m.get(s.categoryName) ?? []), s]);
    return [...m.entries()];
  }, [services]);

  const qualified = (d: StaffDetail, serviceId: string) => d.services.some((x) => x.serviceId === serviceId && x.isActive);
  const needsSkill = (d: StaffDetail, serviceExpertise: string[]) => serviceExpertise.length > 0 && !serviceExpertise.some((id) => d.expertise.some((e) => e.id === id));

  const toggle = useMutation({
    mutationFn: ({ d, serviceId, on }: { d: StaffDetail; serviceId: string; on: boolean }) => {
      const rest = d.services.filter((x) => x.serviceId !== serviceId).map((x) => ({ serviceId: x.serviceId, isActive: x.isActive, durationMinutes: x.durationMinutes, priceOverride: x.priceOverride, commissionType: x.commissionType, commissionValue: x.commissionValue }));
      const existing = d.services.find((x) => x.serviceId === serviceId);
      const next = [...rest, { serviceId, isActive: on, durationMinutes: existing?.durationMinutes ?? null, priceOverride: existing?.priceOverride ?? null, commissionType: existing?.commissionType ?? null, commissionValue: existing?.commissionValue ?? null }];
      return api.put<StaffDetail>(`/staff/${d.id}/services`, { services: next });
    },
    onMutate: ({ d, serviceId }) => setPending((p) => new Set(p).add(`${d.id}:${serviceId}`)),
    onSuccess: (saved) => { client.setQueryData(staffDetailKey(saved.id), saved); void client.invalidateQueries({ queryKey: ['services'] }); void client.invalidateQueries({ queryKey: ['staff'] }); void client.invalidateQueries({ queryKey: ['availability'] }); },
    onError: (e) => toast.error(friendlyError(e).message),
    onSettled: (_r, _e, v) => setPending((p) => { const n = new Set(p); n.delete(`${v.d.id}:${v.serviceId}`); return n; }),
  });

  if (staffQ.isLoading || servicesQ.isLoading || loading) return <div role="status" aria-label="Loading assignments" className="space-y-2"><Skeleton className="h-12" /><Skeleton className="h-64" /></div>;
  if (staffQ.isError || servicesQ.isError || error) return <ErrorState error={staffQ.error ?? servicesQ.error ?? error} onRetry={() => { void staffQ.refetch(); void servicesQ.refetch(); }} />;
  if (staff.length === 0 || services.length === 0) return <div><PageHeader title="Assign services" /><Card><EmptyState title={staff.length === 0 ? 'No bookable team members' : 'No services yet'} description={staff.length === 0 ? 'Add team members who take appointments first.' : 'Add services first, then choose who can do them.'} /></Card></div>;

  const uncovered = services.filter((s) => !staff.some((d) => qualified(d, s.id)));
  return (
    <div className="space-y-4">
      <PageHeader title="Assign services" description="Choose who can do each service. Booking only offers people ticked here." />
      {uncovered.length > 0 && <InlineNotice tone="warning" title={`${uncovered.length} ${uncovered.length === 1 ? 'service has' : 'services have'} nobody assigned`}>{uncovered.map((s) => s.name).join(', ')} cannot be booked until someone is ticked.</InlineNotice>}
      {branches.length > 1 && !scopeBranchId && <InlineNotice tone="info">Showing team members from every branch. Choose a branch at the top for a smaller grid.</InlineNotice>}
      <Card padded={false}>
        <div className="scroll-thin max-h-[70vh] overflow-auto">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <caption className="sr-only">Which team member can do which service</caption>
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 top-0 z-20 min-w-48 border-b border-line bg-surface px-4 py-3 text-left font-medium text-muted">Service</th>
                {staff.map((d) => <th scope="col" key={d.id} className="sticky top-0 z-10 min-w-24 border-b border-line bg-surface px-2 py-3 text-center font-medium"><Link to={`/staff/${d.id}?tab=services`} className="flex flex-col items-center gap-1 hover:text-primary"><Avatar name={d.displayName} color={d.calendarColor} src={d.photoUrl} size="sm" /><span className="max-w-24 truncate text-xs">{d.displayName}</span></Link></th>)}
              </tr>
            </thead>
            <tbody>
              {grouped.map(([category, items]) => (
                <GroupRows key={category} category={category} colSpan={staff.length + 1}>
                  {items.map((s) => (
                    <tr key={s.id} className="hover:bg-surface-2/50">
                      <th scope="row" className="sticky left-0 z-10 border-b border-line bg-surface px-4 py-2 text-left font-normal"><span className="block font-medium">{s.name}</span>{!staff.some((d) => qualified(d, s.id)) && <Badge tone="warning">Nobody yet</Badge>}</th>
                      {staff.map((d) => {
                        const locked = needsSkill(d, s.expertiseIds);
                        const key = `${d.id}:${s.id}`;
                        const on = qualified(d, s.id);
                        return (
                          <td key={d.id} className="border-b border-line px-2 py-2 text-center" title={locked && !on ? `${d.displayName} needs the right skill for ${s.name}` : undefined}>
                            <span className="inline-flex"><Checkbox checked={on} disabled={!manage || pending.has(key) || (locked && !on)} onCheckedChange={(v) => toggle.mutate({ d, serviceId: s.id, on: v })} label={<span className="sr-only">{d.displayName} can do {s.name}</span>} /></span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </GroupRows>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="text-xs text-muted">A greyed box means the person does not have the skill the service needs. Add the skill on their profile first.</p>
    </div>
  );
}

function GroupRows({ category, colSpan, children }: { category: string; colSpan: number; children: React.ReactNode }) {
  return (
    <>
      <tr><th scope="colgroup" colSpan={colSpan} className="sticky left-0 border-b border-line bg-surface-2 px-4 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-muted">{category}</th></tr>
      {children}
    </>
  );
}
