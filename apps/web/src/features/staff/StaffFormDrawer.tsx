import { zodResolver } from '@hookform/resolvers/zod';
import { COMMISSION_TYPES, EMPLOYMENT_STATUSES, EMPLOYMENT_STATUS_LABELS, EMPLOYMENT_TYPES, GENDERS, GENDER_LABELS, staffSchema } from '@salon/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { DateInput, Field, FormError, Input, MoneyInput, Select, Switch, Textarea } from '@/components/ui/form';
import { Drawer } from '@/components/ui/overlay';
import { api, ApiError } from '@/lib/api';
import { useBranch } from '@/lib/branch';
import { friendlyError } from '@/lib/errors';
import { useExpertise } from '@/lib/queries';
import { staffDetailKey, type StaffDetail } from './hooks';

type FormIn = z.input<typeof staffSchema>;
type FormOut = z.output<typeof staffSchema>;

const EMPLOYMENT_TYPE_LABEL: Record<string, string> = { full_time: 'Full time', part_time: 'Part time', contract: 'Contract', freelance: 'Freelance' };
const COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#0ea5e9', '#8b5cf6', '#f43f5e', '#14b8a6'];

/** Add or edit a team member. New members start with the branch’s opening hours and the services their skills allow. */
export function StaffFormDrawer({ staff, suggestedCode, onClose, onSaved }: { staff: StaffDetail | null; suggestedCode?: string; onClose: () => void; onSaved?: (s: StaffDetail) => void }) {
  const client = useQueryClient();
  const { branches, branchId } = useBranch();
  const expertise = useExpertise();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(staffSchema),
    defaultValues: {
      branchId: staff?.branchId ?? branchId,
      employeeCode: staff?.employeeCode ?? suggestedCode ?? '',
      fullName: staff?.fullName ?? '',
      displayName: staff?.displayName ?? '',
      gender: (staff?.gender as FormIn['gender']) ?? 'unspecified',
      dateOfBirth: staff?.dateOfBirth ?? '',
      mobile: staff?.mobile ?? '',
      email: staff?.email ?? '',
      address: staff?.address ?? '',
      joiningDate: staff?.joiningDate ?? '',
      exitDate: staff?.exitDate ?? '',
      designation: staff?.designation ?? '',
      employmentType: staff?.employmentType ?? 'full_time',
      employmentStatus: staff?.employmentStatus ?? 'active',
      biometricPunchId: staff?.biometricPunchId ?? '',
      photoUrl: staff?.photoUrl ?? '',
      calendarColor: staff?.calendarColor ?? COLORS[Math.floor(Math.random() * COLORS.length)],
      calendarOrder: staff?.calendarOrder ?? 0,
      isBookable: staff?.isBookable ?? true,
      onlineBookable: staff?.onlineBookable ?? true,
      commissionType: staff?.commissionType ?? 'none',
      commissionValue: staff?.commissionValue ?? 0,
      notes: staff?.notes ?? '',
      expertiseIds: staff?.expertise.map((e) => e.id) ?? [],
    },
  });
  const v = form.watch();
  const errors = form.formState.errors;
  const set = <K extends keyof FormIn>(key: K, value: FormIn[K]) => form.setValue(key, value as never, { shouldDirty: true });
  const save = useMutation({
    mutationFn: (body: FormOut) => (staff ? api.put<StaffDetail>(`/staff/${staff.id}`, body) : api.post<StaffDetail>('/staff', body)),
    onSuccess: (saved) => {
      client.setQueryData(staffDetailKey(saved.id), saved);
      void client.invalidateQueries({ queryKey: ['staff'] });
      void client.invalidateQueries({ queryKey: ['services'] });
      void client.invalidateQueries({ queryKey: ['calendar'] });
      toast.success(staff ? 'Changes saved' : `${saved.displayName} added to the team`);
      onSaved?.(saved);
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError) for (const [path, message] of Object.entries(e.fieldErrors)) form.setError(path as keyof FormIn, { message });
      setError(friendlyError(e).message);
    },
  });
  const submit = form.handleSubmit((body) => { setError(null); save.mutate(body); });
  const toggleSkill = (id: string) => set('expertiseIds', v.expertiseIds?.includes(id) ? v.expertiseIds.filter((x) => x !== id) : [...(v.expertiseIds ?? []), id]);

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={staff ? `Edit ${staff.displayName}` : 'Add team member'} size="lg" persistent footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={save.isPending}>{staff ? 'Save changes' : 'Add to team'}</Button></>}>
      <form onSubmit={submit} className="space-y-6" noValidate>
        <FormError message={error} />
        <section className="grid gap-4 sm:grid-cols-2" aria-label="Basic details">
          <Field label="Full name" required error={errors.fullName?.message}><Input autoFocus {...form.register('fullName', { onBlur: (e) => { if (!v.displayName) set('displayName', String(e.target.value).trim().split(/\s+/)[0] ?? ''); } })} /></Field>
          <Field label="Name shown on the calendar" required error={errors.displayName?.message} hint="Short and friendly, e.g. “Priya”."><Input {...form.register('displayName')} /></Field>
          <Field label="Mobile number" optional error={errors.mobile?.message}><Input type="tel" inputMode="tel" {...form.register('mobile')} /></Field>
          <Field label="Email" optional error={errors.email?.message}><Input type="email" {...form.register('email')} /></Field>
          <Field label="Role" optional hint="e.g. Senior stylist, Therapist, Receptionist."><Input {...form.register('designation')} /></Field>
          <Field label="Employee code" required error={errors.employeeCode?.message}><Input className="uppercase" {...form.register('employeeCode')} /></Field>
          {branches.length > 1 && <Field label="Branch" required error={errors.branchId?.message}><Select {...form.register('branchId')}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>}
          <Field label="Gender" optional><Select {...form.register('gender')}>{GENDERS.map((g) => <option key={g} value={g}>{GENDER_LABELS[g]}</option>)}</Select></Field>
          <Field label="Date of birth" optional><DateInput {...form.register('dateOfBirth')} /></Field>
          <Field label="Joined on" optional><DateInput {...form.register('joiningDate')} /></Field>
        </section>

        <fieldset>
          <legend className="text-sm font-semibold">Skills</legend>
          <p className="mb-2 text-xs text-muted">Ticking skills lets us suggest this person for matching services automatically.</p>
          <div className="flex flex-wrap gap-2">
            {(expertise.data ?? []).map((e) => { const on = v.expertiseIds?.includes(e.id); return <button key={e.id} type="button" aria-pressed={on} onClick={() => toggleSkill(e.id)} className={`rounded-full border px-3 py-1.5 text-sm max-md:min-h-10 ${on ? 'border-primary bg-primary-soft text-primary-soft-fg' : 'border-line hover:border-primary/50'}`}>{e.name}</button>; })}
            {expertise.data?.length === 0 && <p className="text-sm text-muted">No skills defined yet. Add them under Services → Expertise.</p>}
          </div>
        </fieldset>

        <section className="space-y-3" aria-label="Calendar and booking">
          <h3 className="text-sm font-semibold">Calendar and booking</h3>
          <Switch checked={!!v.isBookable} onCheckedChange={(x) => set('isBookable', x)} label="Can be booked for appointments" description="Switch off for reception or back-office staff." />
          <Switch checked={!!v.onlineBookable} onCheckedChange={(x) => set('onlineBookable', x)} label="Customers can pick them online" />
          <div>
            <p className="mb-1.5 text-sm font-medium">Calendar colour</p>
            <div className="flex flex-wrap gap-2">{COLORS.map((c) => <button key={c} type="button" aria-label={`Colour ${c}`} aria-pressed={v.calendarColor === c} onClick={() => set('calendarColor', c)} className={`size-8 rounded-full border-2 ${v.calendarColor === c ? 'border-fg' : 'border-transparent'}`} style={{ background: c }} />)}</div>
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2" aria-label="Employment">
          <h3 className="text-sm font-semibold sm:col-span-2">Employment</h3>
          <Field label="Employment type"><Select {...form.register('employmentType')}>{EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{EMPLOYMENT_TYPE_LABEL[t]}</option>)}</Select></Field>
          <Field label="Status"><Select {...form.register('employmentStatus')}>{EMPLOYMENT_STATUSES.map((t) => <option key={t} value={t}>{EMPLOYMENT_STATUS_LABELS[t]}</option>)}</Select></Field>
          {(v.employmentStatus === 'terminated' || v.employmentStatus === 'on_notice') && <Field label="Last working day" optional><DateInput {...form.register('exitDate')} /></Field>}
          <Field label="Biometric ID" optional hint="The number registered on the attendance machine."><Input {...form.register('biometricPunchId')} /></Field>
          <Field label="Commission"><Select {...form.register('commissionType')}>{COMMISSION_TYPES.map((t) => <option key={t} value={t}>{t === 'none' ? 'No commission' : t === 'percentage' ? 'Percentage of service' : 'Fixed per service'}</option>)}</Select></Field>
          {v.commissionType === 'percentage' && <Field label="Percentage"><Input type="number" min={0} max={100} step={0.5} suffix="%" value={(v.commissionValue ?? 0) / 100} onChange={(e) => set('commissionValue', Math.round(Number(e.target.value) * 100))} /></Field>}
          {v.commissionType === 'flat' && <Field label="Amount per service"><MoneyInput value={v.commissionValue ?? 0} onChange={(m) => set('commissionValue', m ?? 0)} /></Field>}
        </section>
        <Field label="Address" optional><Textarea rows={2} {...form.register('address')} /></Field>
        <Field label="Private notes" optional hint="Only managers see this."><Textarea rows={2} {...form.register('notes')} /></Field>
      </form>
    </Drawer>
  );
}
