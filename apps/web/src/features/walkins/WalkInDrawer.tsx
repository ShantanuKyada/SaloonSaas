import type { AppointmentDto, SalonNow } from '@salon/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CustomerPicker, toPicked, useCustomer360, type PickedCustomer } from '@/components/common/CustomerPicker';
import { ServicePicker } from '@/components/common/ServicePicker';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/display';
import { Field, Select, Switch } from '@/components/ui/form';
import { Drawer } from '@/components/ui/overlay';
import { api } from '@/lib/api';
import { useBranch } from '@/lib/branch';
import { friendlyError } from '@/lib/errors';
import { useServices, useStaffList } from '@/lib/queries';

/** A customer just walked in: customer → services → (optionally) who → done. Starts immediately if someone is free. */
export default function WalkInDrawer({ prefill, onClose }: { prefill: { customerId?: string }; onClose: () => void }) {
  const client = useQueryClient();
  const { branchId } = useBranch();
  const [customerId, setCustomerId] = useState<string | null>(prefill.customerId ?? null);
  const [picked, setPicked] = useState<PickedCustomer | null>(null);
  const loaded = useCustomer360(customerId);
  useEffect(() => {
    if (loaded.data) setPicked(toPicked(loaded.data));
  }, [loaded.data]);
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [staffByService, setStaffByService] = useState<Record<string, string>>({});
  const [startNow, setStartNow] = useState(false);
  const services = useServices(branchId, { popular: true });
  const staff = useStaffList(branchId, { bookableOnly: true });
  const live = useQuery({ queryKey: ['dashboard', 'now', branchId], queryFn: () => api.get<SalonNow & { branchId: string }>('/dashboard/now', { branchId }), refetchInterval: 20_000 });
  const lookup = new Map((services.data ?? []).map((s) => [s.id, s]));
  const stateOf = (staffId: string) => live.data?.staff.find((s) => s.staffId === staffId);

  // Who is qualified for each chosen service comes from the full team list plus each person's assigned services.
  const qualified = useQuery({
    queryKey: ['walkin-qualified', branchId, serviceIds.join(',')],
    enabled: serviceIds.length > 0,
    queryFn: async () => Object.fromEntries(await Promise.all(serviceIds.map(async (id) => [id, (await api.list<{ id: string; displayName: string }>('/staff', { branchId, serviceId: id, bookableOnly: 'true', pageSize: 100 })).rows] as const))),
  });

  const create = useMutation({
    mutationFn: () => api.post<AppointmentDto>('/walkins', { branchId, customerId, items: serviceIds.map((serviceId) => ({ serviceId, staffId: staffByService[serviceId] || undefined })), startNow }),
    onSuccess: (a) => {
      for (const key of ['walkins', 'appointments', 'calendar', 'dashboard', 'customer-360']) void client.invalidateQueries({ queryKey: [key] });
      toast.success(`${a.customer.fullName.split(' ')[0]} is ${a.status === 'in_service' ? 'being served' : `in the queue (#${a.queueNumber})`}`);
      onClose();
    },
  });
  const err = create.error ? friendlyError(create.error) : null;
  const everyoneAssigned = serviceIds.length > 0 && serviceIds.every((id) => staffByService[id]);
  const ready = !!customerId && serviceIds.length > 0 && (!startNow || everyoneAssigned);

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title="Walk-in"
      description="Register the customer now; choose a team member now or later."
      persistent
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={!ready} loading={create.isPending}>{startNow ? 'Start service now' : 'Add to queue'}</Button>
        </>
      }
    >
      <div className="space-y-6">
        {err && <InlineNotice tone="danger" title={err.title}>{err.message}</InlineNotice>}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Customer</h3>
          <CustomerPicker value={customerId} autoFocus={!prefill.customerId} onChange={(c) => { setCustomerId(c?.id ?? null); setPicked(c); }} />
        </section>
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Services</h3>
          <ServicePicker services={services.data ?? []} selected={serviceIds} onToggle={(id) => setServiceIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))} usualIds={[picked?.favoriteServiceId, picked?.suggestion?.serviceId].filter((v): v is string => !!v)} />
        </section>
        {serviceIds.length > 0 && (
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Team member <span className="font-normal text-muted">(optional: you can assign later)</span></h3>
            {serviceIds.map((id) => (
              <Field key={id} label={lookup.get(id)?.name ?? 'Service'}>
                <Select value={staffByService[id] ?? ''} onChange={(e) => setStaffByService((m) => ({ ...m, [id]: e.target.value }))}>
                  <option value="">Assign later</option>
                  {(qualified.data?.[id] ?? []).map((s) => {
                    const st = stateOf(s.id);
                    return <option key={s.id} value={s.id}>{s.displayName}{st ? ` — ${st.label}` : ''}</option>;
                  })}
                </Select>
              </Field>
            ))}
            <Switch checked={startNow} onCheckedChange={setStartNow} label="Start the service right now" description={everyoneAssigned ? 'The service starts immediately and the team member’s calendar is blocked.' : 'Choose a team member for every service to start right away.'} disabled={!everyoneAssigned} />
          </section>
        )}
        {staff.data && staff.data.length === 0 && <InlineNotice tone="warning" title="No team members are set up at this branch yet" />}
      </div>
    </Drawer>
  );
}
