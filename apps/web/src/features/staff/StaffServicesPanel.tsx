import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Money } from '@/components/common/badges';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, InlineNotice } from '@/components/ui/display';
import { Checkbox, FormError, Input, MoneyInput } from '@/components/ui/form';
import { api } from '@/lib/api';
import { friendlyError } from '@/lib/errors';
import { fmtDuration } from '@/lib/format';
import { useServices } from '@/lib/queries';
import { staffDetailKey, type StaffDetail } from './hooks';

interface Row { on: boolean; duration: number | null; price: number | null }

/** Which services this person can do, with optional personal time and price (a senior stylist may charge more). */
export function StaffServicesPanel({ staff, canEdit }: { staff: StaffDetail; canEdit: boolean }) {
  const client = useQueryClient();
  const services = useServices(staff.branchId);
  const [error, setError] = useState<string | null>(null);
  const initial = useMemo(() => new Map(staff.services.map((s) => [s.serviceId, { on: s.isActive, duration: s.durationMinutes, price: s.priceOverride }] as const)), [staff.services]);
  const [rows, setRows] = useState<Map<string, Row>>(initial);
  const [dirty, setDirty] = useState(false);
  const skillIds = new Set(staff.expertise.map((e) => e.id));
  const list = services.data ?? [];
  const byCategory = useMemo(() => {
    const groups = new Map<string, typeof list>();
    for (const s of list) groups.set(s.categoryName, [...(groups.get(s.categoryName) ?? []), s]);
    return [...groups.entries()];
  }, [list]);
  const get = (id: string): Row => rows.get(id) ?? { on: false, duration: null, price: null };
  const update = (id: string, patch: Partial<Row>) => { setRows((m) => new Map(m).set(id, { ...get(id), ...patch })); setDirty(true); setError(null); };
  const missingSkill = (serviceExpertise: string[]) => serviceExpertise.length > 0 && !serviceExpertise.some((id) => skillIds.has(id));

  const save = useMutation({
    mutationFn: () => api.put<StaffDetail>(`/staff/${staff.id}/services`, { services: [...rows.entries()].filter(([, r]) => r.on || r.duration !== null || r.price !== null).map(([serviceId, r]) => ({ serviceId, isActive: r.on, durationMinutes: r.duration, priceOverride: r.price })) }),
    onSuccess: (saved) => { client.setQueryData(staffDetailKey(staff.id), saved); void client.invalidateQueries({ queryKey: ['services'] }); void client.invalidateQueries({ queryKey: ['staff'] }); void client.invalidateQueries({ queryKey: ['availability'] }); setDirty(false); toast.success('Services saved'); },
    onError: (e) => setError(friendlyError(e).message),
  });
  const autoMap = useMutation({
    mutationFn: () => api.post<StaffDetail>(`/staff/${staff.id}/services/auto-map`),
    onSuccess: (saved) => {
      client.setQueryData(staffDetailKey(staff.id), saved);
      setRows(new Map(saved.services.map((s) => [s.serviceId, { on: s.isActive, duration: s.durationMinutes, price: s.priceOverride }] as const)));
      setDirty(false);
      void client.invalidateQueries({ queryKey: ['services'] });
      toast.success('Services matched to their skills');
    },
    onError: (e) => setError(friendlyError(e).message),
  });

  if (services.isLoading) return <p role="status" className="text-sm text-muted">Loading services…</p>;
  if (list.length === 0) return <EmptyState title="No services yet" description="Add services first, then choose who can do them." />;

  return (
    <div className="space-y-4">
      <FormError message={error} />
      {staff.expertise.length === 0 && <InlineNotice tone="warning" title="No skills set">Add skills to this person so services can be matched automatically.</InlineNotice>}
      {canEdit && <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm text-muted">Tick the services {staff.displayName} can do. Untick to stop offering a service.</p><Button size="sm" variant="outline" icon={<Sparkles className="size-4" />} loading={autoMap.isPending} onClick={() => autoMap.mutate()}>Match to their skills</Button></div>}
      {byCategory.map(([category, items]) => (
        <section key={category} aria-label={category}>
          <h3 className="mb-1 text-sm font-semibold">{category}</h3>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {items.map((s) => {
              const r = get(s.id);
              const blocked = missingSkill(s.expertiseIds);
              return (
                <li key={s.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1 basis-48">
                    <Checkbox checked={r.on} disabled={!canEdit || (blocked && !r.on)} onCheckedChange={(on) => update(s.id, { on })} label={s.name} description={blocked && !r.on ? 'Needs a skill they do not have yet' : `${fmtDuration(s.durationMinutes)} · standard price`} />
                  </div>
                  {blocked && r.on && <Badge tone="warning">Missing skill</Badge>}
                  {r.on && (
                    <div className="flex flex-wrap items-center gap-3">
                      <label className="flex items-center gap-1.5 text-xs text-muted">Time<Input type="number" min={5} step={5} disabled={!canEdit} aria-label={`Minutes for ${s.name}`} placeholder={String(s.durationMinutes)} value={r.duration ?? ''} onChange={(e) => update(s.id, { duration: e.target.value === '' ? null : Number(e.target.value) })} className="w-20" suffix="min" /></label>
                      <label className="flex items-center gap-1.5 text-xs text-muted">Price<div className="w-28"><MoneyInput value={r.price} placeholder={String(s.price / 100)} disabled={!canEdit} onChange={(m) => update(s.id, { price: m })} /></div></label>
                      {r.price !== null && r.price !== s.price && <span className="text-xs text-muted">instead of <Money value={s.price} /></span>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {canEdit && (
        <div className="sticky bottom-0 -mx-1 flex items-center justify-end gap-3 border-t border-line bg-surface/95 px-1 py-3 backdrop-blur">
          {dirty && <span className="text-sm text-muted">You have unsaved changes.</span>}
          <Button variant="outline" disabled={!dirty} onClick={() => { setRows(initial); setDirty(false); setError(null); }}>Undo changes</Button>
          <Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>Save services</Button>
        </div>
      )}
    </div>
  );
}
