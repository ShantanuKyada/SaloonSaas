import { zodResolver } from '@hookform/resolvers/zod';
import { CUSTOMER_SOURCE_LABELS, CUSTOMER_SOURCES, GENDER_LABELS, GENDERS, customerSchema, type CustomerDetail, type CustomerInput } from '@salon/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/display';
import { DateInput, Field, FormError, Input, MoneyInput, Select, Switch, Textarea } from '@/components/ui/form';
import { Modal } from '@/components/ui/overlay';
import { api, ApiError } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { friendlyError } from '@/lib/errors';
import { useStaffList } from '@/lib/queries';

interface Props {
  onClose: () => void;
  onCreated?: (customerId: string) => void;
  initial?: { name?: string; mobile?: string };
  /** Pass a customer to edit instead of adding. */
  customer?: CustomerDetail;
}

type Form = CustomerInput;

/** "Add customer": only name and mobile are needed; everything else is under "More details". */
export default function CustomerFormModal({ onClose, onCreated, initial, customer }: Props) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const can = useCan();
  const { branches, branchId } = useBranch();
  const [more, setMore] = useState(!!customer);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<{ id: string; fullName: string; customerCode: string } | null>(null);
  const staff = useStaffList(undefined, { bookableOnly: true });

  const form = useForm<Form>({
    resolver: zodResolver(customerSchema),
    defaultValues: {
      fullName: customer?.fullName ?? initial?.name ?? '',
      mobile: customer?.mobile ?? initial?.mobile ?? '',
      whatsappNumber: customer?.whatsappNumber ?? '',
      email: customer?.email ?? '',
      gender: customer?.gender ?? 'unspecified',
      dateOfBirth: customer?.dateOfBirth ?? '',
      anniversaryDate: customer?.anniversaryDate ?? '',
      address: customer?.address ?? '',
      city: customer?.city ?? '',
      preferredBranchId: customer?.preferredBranchId ?? (branches.length > 1 ? '' : branchId),
      preferredStaffId: customer?.preferredStaffId ?? '',
      source: customer?.source ?? 'walk_in',
      notes: customer?.notes ?? '',
      creditLimit: customer?.creditLimit ?? null,
      marketingConsent: customer?.marketingConsent ?? false,
      tags: customer?.tags ?? [],
    },
  });

  const save = useMutation({
    mutationFn: (v: Form) => (customer ? api.put<CustomerDetail>(`/customers/${customer.id}`, v) : api.post<CustomerDetail>('/customers', v)),
    onSuccess: (saved) => {
      void client.invalidateQueries({ queryKey: ['customers'] });
      void client.invalidateQueries({ queryKey: ['customer-search'] });
      void client.invalidateQueries({ queryKey: ['customer-360', saved.id] });
      void client.invalidateQueries({ queryKey: ['customer', saved.id] });
      toast.success(customer ? 'Customer updated' : `${saved.fullName} added`);
      onCreated?.(saved.id);
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.errorCode === 'DUPLICATE_CUSTOMER') {
        setExisting((e.details.existing as { id: string; fullName: string; customerCode: string }) ?? null);
        setError(null);
        return;
      }
      if (e instanceof ApiError) for (const [path, message] of Object.entries(e.fieldErrors)) form.setError(path as keyof Form, { message });
      setError(friendlyError(e).message);
    },
  });

  const submit = form.handleSubmit((v) => {
    setError(null);
    setExisting(null);
    save.mutate(v);
  });
  const errors = form.formState.errors;

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={customer ? 'Edit customer' : 'Add customer'}
      description={customer ? undefined : 'Just a name and mobile number is enough to start.'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={save.isPending}>{customer ? 'Save changes' : 'Add customer'}</Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormError message={error} />
        {existing && (
          <InlineNotice
            tone="warning"
            title={`This mobile number already belongs to ${existing.fullName}`}
            action={
              <Button
                size="sm"
                onClick={() => {
                  onClose();
                  if (onCreated) onCreated(existing.id);
                  else navigate(`/customers/${existing.id}`);
                }}
              >
                Open existing customer
              </Button>
            }
          >
            Customer {existing.customerCode}. Use their record so their history stays in one place.
          </InlineNotice>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" required error={errors.fullName?.message} className="sm:col-span-2">
            <Input autoFocus autoComplete="off" placeholder="e.g. Meera Patel" {...form.register('fullName')} />
          </Field>
          <Field label="Mobile number" error={errors.mobile?.message} hint="Used to find them quickly and to send booking messages.">
            <Input type="tel" inputMode="tel" autoComplete="off" placeholder="98765 43210" {...form.register('mobile')} />
          </Field>
          <Field label="Gender" optional>
            <Select {...form.register('gender')}>
              {GENDERS.map((g) => (
                <option key={g} value={g}>{GENDER_LABELS[g]}</option>
              ))}
            </Select>
          </Field>
          <Field label="Email" optional error={errors.email?.message}>
            <Input type="email" autoComplete="off" {...form.register('email')} />
          </Field>
          <Field label="Date of birth" optional hint="For birthday offers.">
            <DateInput {...form.register('dateOfBirth')} />
          </Field>
        </div>

        <Switch
          checked={!!form.watch('marketingConsent')}
          onCheckedChange={(v) => form.setValue('marketingConsent', v, { shouldDirty: true })}
          label="OK to send offers and promotions"
          description="Booking confirmations and receipts are always sent. Tick this only if the customer agrees to hear about offers."
        />

        <button type="button" onClick={() => setMore((m) => !m)} className="flex items-center gap-1.5 text-sm font-medium text-primary" aria-expanded={more}>
          <ChevronDown className={`size-4 transition-transform ${more ? 'rotate-180' : ''}`} />
          {more ? 'Fewer details' : 'More details'}
        </button>
        {more && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="WhatsApp number" optional hint="If different from the mobile number.">
              <Input type="tel" inputMode="tel" {...form.register('whatsappNumber')} />
            </Field>
            <Field label="Anniversary" optional>
              <DateInput {...form.register('anniversaryDate')} />
            </Field>
            <Field label="City" optional>
              <Input {...form.register('city')} />
            </Field>
            <Field label="How did they find us?" optional>
              <Select {...form.register('source')}>
                {CUSTOMER_SOURCES.map((s) => (
                  <option key={s} value={s}>{CUSTOMER_SOURCE_LABELS[s]}</option>
                ))}
              </Select>
            </Field>
            {branches.length > 1 && (
              <Field label="Usual branch" optional>
                <Select {...form.register('preferredBranchId')}>
                  <option value="">No preference</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Favourite team member" optional>
              <Select {...form.register('preferredStaffId')}>
                <option value="">No preference</option>
                {(staff.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.displayName} · {s.branchName}</option>
                ))}
              </Select>
            </Field>
            <Field label="Address" optional className="sm:col-span-2">
              <Textarea rows={2} {...form.register('address')} />
            </Field>
            <Field label="Notes" optional className="sm:col-span-2" hint="Allergies, preferences, anything the team should know.">
              <Textarea rows={2} {...form.register('notes')} />
            </Field>
            {can(['billing.override_credit_limit', 'ledger.adjust']) && (
              <Field label="Credit limit" optional hint="Leave empty for no limit. Enter 0 to not allow pay-later.">
                <MoneyInput value={form.watch('creditLimit') ?? null} onChange={(v) => form.setValue('creditLimit', v, { shouldDirty: true })} />
              </Field>
            )}
          </div>
        )}
      </form>
    </Modal>
  );
}
