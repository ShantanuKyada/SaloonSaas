import { zodResolver } from '@hookform/resolvers/zod';
import { organizationProfileSchema, organizationSettingsSchema, TWO_FACTOR_REQUIREMENT_LABELS, TWO_FACTOR_REQUIREMENTS, type OrganizationSettingsInput, type TwoFactorRequirement } from '@salon/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink, Sparkles } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, ErrorState, InlineNotice, PageHeader, Skeleton, TabPanel, Tabs } from '@/components/ui/display';
import { Field, FormError, Input, MoneyInput, Select, Switch, TimeInput, Textarea } from '@/components/ui/form';
import { api, ApiError } from '@/lib/api';
import { useAuth, useCan, useUser } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { withCurrent } from '@/lib/timezones';
import { ConnectionsPanel } from './ConnectionsPanel';

type Settings = Required<OrganizationSettingsInput> & { receiptFooter: string | null };
type ProfileIn = z.input<typeof organizationProfileSchema>;
type ProfileOut = z.output<typeof organizationProfileSchema>;

const hhmm = (v: string | undefined) => (v ?? '').slice(0, 5);
const REMINDERS = [{ minutes: 2880, label: '2 days before' }, { minutes: 1440, label: '1 day before' }, { minutes: 360, label: '6 hours before' }, { minutes: 180, label: '3 hours before' }, { minutes: 120, label: '2 hours before' }, { minutes: 60, label: '1 hour before' }, { minutes: 30, label: '30 minutes before' }];
const NOTICE = [{ v: 0, l: 'No minimum' }, { v: 30, l: '30 minutes' }, { v: 60, l: '1 hour' }, { v: 120, l: '2 hours' }, { v: 240, l: '4 hours' }, { v: 720, l: '12 hours' }, { v: 1440, l: '1 day' }];

function Section({ title, description, children, footer }: { title: string; description?: string; children: ReactNode; footer?: ReactNode }) {
  return <Card><CardHeader title={title} description={description} /><div className="space-y-4">{children}</div>{footer && <div className="mt-5 flex justify-end">{footer}</div>}</Card>;
}

export function Component() {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const user = useUser();
  const tabs = [
    ...(can('settings.manage') ? [{ value: 'salon', label: 'Salon' }, { value: 'booking', label: 'Booking' }, { value: 'billing', label: 'Bills and money' }, { value: 'messages', label: 'Reminders' }, { value: 'privacy', label: 'Privacy' }] : []),
    ...(can('integrations.manage') ? [{ value: 'connections', label: 'Connections' }] : []),
  ];
  const tab = tabs.some((t) => t.value === params.get('tab')) ? params.get('tab')! : tabs[0]?.value ?? 'salon';
  const setupDone = user.organization?.onboardingCompleted;
  return (
    <div>
      <PageHeader title="Settings" description="How your salon works. Changes apply straight away." actions={can('settings.manage') && <Link className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-line px-3 text-sm font-medium hover:bg-surface-2" to="/settings/setup"><Sparkles className="size-4" aria-hidden />{setupDone ? 'Review setup guide' : 'Continue setup guide'}</Link>} />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })} tabs={tabs}>
        <TabPanel value="salon"><ProfilePanel /></TabPanel>
        <TabPanel value="booking"><BookingPanel /></TabPanel>
        <TabPanel value="billing"><BillingPanel /></TabPanel>
        <TabPanel value="messages"><MessagesPanel /></TabPanel>
        <TabPanel value="privacy"><PrivacyPanel /></TabPanel>
        <TabPanel value="connections"><ConnectionsPanel /></TabPanel>
      </Tabs>
    </div>
  );
}

// ───────────── Salon profile ─────────────
function ProfilePanel() {
  const client = useQueryClient();
  const { reloadUser } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['organization'], queryFn: () => api.get<ProfileIn & { id: string }>('/organization') });
  const form = useForm<ProfileIn, unknown, ProfileOut>({ resolver: zodResolver(organizationProfileSchema) });
  useEffect(() => { if (q.data) form.reset({ ...q.data, legalName: q.data.legalName ?? '', contactPerson: q.data.contactPerson ?? '', email: q.data.email ?? '', phone: q.data.phone ?? '', addressLine1: q.data.addressLine1 ?? '', addressLine2: q.data.addressLine2 ?? '', city: q.data.city ?? '', state: q.data.state ?? '', postalCode: q.data.postalCode ?? '', taxId: q.data.taxId ?? '', logoUrl: q.data.logoUrl ?? '' }); }, [q.data, form]);
  const errors = form.formState.errors;
  const save = useMutation({
    mutationFn: (body: ProfileOut) => api.put('/organization', body),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['organization'] }); await reloadUser(); form.reset(form.getValues()); toast.success('Salon details saved'); },
    onError: (e) => { if (e instanceof ApiError) for (const [path, message] of Object.entries(e.fieldErrors)) form.setError(path as keyof ProfileIn, { message }); setError(friendlyError(e).message); },
  });
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <form onSubmit={form.handleSubmit((b) => { setError(null); save.mutate(b); })} noValidate>
      <Section title="Salon details" description="Shown on bills and receipts." footer={<Button type="submit" loading={save.isPending} disabled={!form.formState.isDirty}>Save changes</Button>}>
        <FormError message={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Salon name" required error={errors.name?.message}><Input {...form.register('name')} /></Field>
          <Field label="Registered business name" optional><Input {...form.register('legalName')} /></Field>
          <Field label="Contact person" optional><Input {...form.register('contactPerson')} /></Field>
          <Field label="Phone" optional error={errors.phone?.message}><Input type="tel" {...form.register('phone')} /></Field>
          <Field label="Email" optional error={errors.email?.message}><Input type="email" {...form.register('email')} /></Field>
          <Field label="Time zone" required error={errors.timezone?.message}><Select {...form.register('timezone')}>{withCurrent(q.data?.timezone).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</Select></Field>
          <Field label="Address" optional className="sm:col-span-2"><Input {...form.register('addressLine1')} /></Field>
          <Field label="Area / landmark" optional className="sm:col-span-2"><Input {...form.register('addressLine2')} /></Field>
          <Field label="City" optional><Input {...form.register('city')} /></Field>
          <Field label="State" optional><Input {...form.register('state')} /></Field>
          <Field label="PIN / postal code" optional><Input {...form.register('postalCode')} /></Field>
          <Field label="Tax name on bills" required error={errors.taxLabel?.message} hint="e.g. GST, VAT"><Input {...form.register('taxLabel')} /></Field>
          <Field label="Tax registration number" optional error={errors.taxId?.message}><Input {...form.register('taxId')} /></Field>
          <Field label="Logo web address" optional error={errors.logoUrl?.message} hint="A link to your logo image."><Input type="url" {...form.register('logoUrl')} /></Field>
        </div>
      </Section>
    </form>
  );
}

// ───────────── Section forms share one settings record ─────────────
function useSettings() {
  const client = useQueryClient();
  const { reloadUser } = useAuth();
  const q = useQuery({ queryKey: ['organization', 'settings'], queryFn: () => api.get<Settings>('/organization/settings') });
  const [draft, setDraft] = useState<Partial<Settings>>({});
  const [error, setError] = useState<string | null>(null);
  const s = q.data ? ({ ...q.data, ...draft } as Settings) : undefined;
  const set = (patch: Partial<Settings>) => { setDraft((d) => ({ ...d, ...patch })); setError(null); };
  const save = useMutation({
    mutationFn: (keys: Array<keyof Settings>) => {
      const body = Object.fromEntries(keys.map((k) => [k, s![k]]));
      if (typeof body.quietHoursStart === 'string') body.quietHoursStart = hhmm(body.quietHoursStart);
      if (typeof body.quietHoursEnd === 'string') body.quietHoursEnd = hhmm(body.quietHoursEnd);
      const parsed = organizationSettingsSchema.safeParse(body);
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.path[0] === 'invoicePrefix' || parsed.error.issues[0]?.path[0] === 'receiptPrefix' || parsed.error.issues[0]?.path[0] === 'bookingPrefix' ? 'Prefixes use 1–6 letters or numbers.' : 'Please check the values you entered.');
      return api.patch('/organization/settings', parsed.data);
    },
    // The signed-in user carries some of these settings, and whether two-step sign-in is now required of them (which
    // moves them to the set-up screen), so they are reloaded first.
    onSuccess: async () => { await reloadUser(); await client.invalidateQueries({ queryKey: ['organization', 'settings'] }); setDraft({}); toast.success('Settings saved'); },
    onError: (e) => setError(e instanceof Error && !(e instanceof ApiError) ? e.message : friendlyError(e).message),
  });
  return { q, s, set, save, error, dirty: Object.keys(draft).length > 0 };
}

function SettingsShell({ children }: { children: (api: ReturnType<typeof useSettings> & { s: Settings }) => ReactNode }) {
  const st = useSettings();
  if (st.q.isLoading) return <Skeleton className="h-96" />;
  if (st.q.isError || !st.s) return <ErrorState error={st.q.error} onRetry={() => void st.q.refetch()} />;
  return <>{children({ ...st, s: st.s })}</>;
}

const saveButton = (st: ReturnType<typeof useSettings>, keys: Array<keyof Settings>) => <Button loading={st.save.isPending} disabled={!st.dirty} onClick={() => st.save.mutate(keys)}>Save changes</Button>;

function BookingPanel() {
  const user = useUser();
  const link = `${window.location.origin}/book/${user.organization?.code ?? ''}`;
  return (
    <SettingsShell>
      {(st) => (
        <div className="space-y-5">
          <Section title="Appointments" footer={saveButton(st, ['slotIntervalMinutes', 'defaultBufferMinutes', 'allowOutsideHours', 'minBookingNoticeMinutes', 'maxAdvanceBookingDays'])}>
            <FormError message={st.error} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Time slots every" hint="How often a new start time is offered."><Select value={st.s.slotIntervalMinutes} onChange={(e) => st.set({ slotIntervalMinutes: Number(e.target.value) as Settings['slotIntervalMinutes'] })}>{[5, 10, 15, 20, 30, 60].map((m) => <option key={m} value={m}>{m} minutes</option>)}</Select></Field>
              <Field label="Clean-up time between customers" hint="Used when a service has no time of its own."><Input type="number" min={0} max={120} step={5} suffix="min" value={st.s.defaultBufferMinutes} onChange={(e) => st.set({ defaultBufferMinutes: Number(e.target.value) })} /></Field>
              <Field label="Shortest notice for a booking"><Select value={st.s.minBookingNoticeMinutes} onChange={(e) => st.set({ minBookingNoticeMinutes: Number(e.target.value) })}>{NOTICE.map((n) => <option key={n.v} value={n.v}>{n.l}</option>)}</Select></Field>
              <Field label="How far ahead people can book" hint="Applies to online booking and front desk."><Input type="number" min={1} max={730} suffix="days" value={st.s.maxAdvanceBookingDays} onChange={(e) => st.set({ maxAdvanceBookingDays: Number(e.target.value) })} /></Field>
            </div>
            <Switch checked={st.s.allowOutsideHours} onCheckedChange={(v) => st.set({ allowOutsideHours: v })} label="Allow booking outside working hours" description="Only people with the “book outside working hours” permission can use this, and the system asks them to confirm." />
          </Section>
          <Section title="Online booking" description="Let customers book from their phone without calling." footer={saveButton(st, ['onlineBookingEnabled'])}>
            <Switch checked={st.s.onlineBookingEnabled} onCheckedChange={(v) => st.set({ onlineBookingEnabled: v })} label="Customers can book online" />
            {st.s.onlineBookingEnabled && (
              <div className="rounded-xl border border-line bg-surface-2 p-3 text-sm">
                <p className="mb-1 font-medium">Your booking page</p>
                <div className="flex flex-wrap items-center gap-2"><code className="min-w-0 flex-1 break-all text-xs">{link}</code><Button size="sm" variant="outline" icon={<Copy className="size-4" />} onClick={() => void navigator.clipboard.writeText(link).then(() => toast.success('Link copied'))}>Copy</Button><a className="inline-flex min-h-8 items-center gap-1 text-sm font-medium text-primary hover:underline" href={link} target="_blank" rel="noreferrer">Open <ExternalLink className="size-3.5" aria-hidden /></a></div>
                <p className="mt-2 text-muted">Only services and team members marked “bookable online” appear.</p>
              </div>
            )}
          </Section>
        </div>
      )}
    </SettingsShell>
  );
}

function BillingPanel() {
  return (
    <SettingsShell>
      {(st) => (
        <div className="space-y-5">
          <Section title="Tax and rounding" footer={saveButton(st, ['pricesIncludeTax', 'defaultTaxRateBp', 'roundOffToMinor'])}>
            <FormError message={st.error} />
            <Switch checked={st.s.pricesIncludeTax} onCheckedChange={(v) => st.set({ pricesIncludeTax: v })} label="Prices already include tax" description="On: the price you set is what the customer pays. Off: tax is added on top." />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Default tax rate" hint="Used when a service has no rate of its own."><Input type="number" min={0} max={100} step={0.5} suffix="%" value={st.s.defaultTaxRateBp / 100} onChange={(e) => st.set({ defaultTaxRateBp: Math.round(Number(e.target.value) * 100) })} /></Field>
              <Field label="Round the bill total to the nearest" hint="Rounding is shown as a separate line."><Select value={st.s.roundOffToMinor} onChange={(e) => st.set({ roundOffToMinor: Number(e.target.value) as Settings['roundOffToMinor'] })}><option value={1}>Exact amount</option><option value={5}>5 paise</option><option value={10}>10 paise</option><option value={50}>50 paise</option><option value={100}>Whole rupee</option></Select></Field>
            </div>
          </Section>
          <Section title="Pay-later accounts" footer={saveButton(st, ['creditDueDays'])}>
            <Field label="Pending amounts are due after" hint="Used for overdue marking and the ageing report."><Input type="number" min={0} max={365} suffix="days" className="max-w-48" value={st.s.creditDueDays} onChange={(e) => st.set({ creditDueDays: Number(e.target.value) })} /></Field>
          </Section>
          <Section title="Bill and receipt numbers" description="Numbers never repeat or skip. Changing a prefix affects only new documents." footer={saveButton(st, ['invoicePrefix', 'receiptPrefix', 'bookingPrefix', 'receiptFooter'])}>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Bills start with"><Input className="uppercase" maxLength={6} value={st.s.invoicePrefix} onChange={(e) => st.set({ invoicePrefix: e.target.value.toUpperCase() })} /></Field>
              <Field label="Receipts start with"><Input className="uppercase" maxLength={6} value={st.s.receiptPrefix} onChange={(e) => st.set({ receiptPrefix: e.target.value.toUpperCase() })} /></Field>
              <Field label="Bookings start with"><Input className="uppercase" maxLength={6} value={st.s.bookingPrefix} onChange={(e) => st.set({ bookingPrefix: e.target.value.toUpperCase() })} /></Field>
            </div>
            <Field label="Message at the bottom of receipts" optional><Textarea rows={2} value={st.s.receiptFooter ?? ''} onChange={(e) => st.set({ receiptFooter: e.target.value })} /></Field>
          </Section>
        </div>
      )}
    </SettingsShell>
  );
}

function MessagesPanel() {
  return (
    <SettingsShell>
      {(st) => {
        const offsets = st.s.reminderOffsetsMinutes ?? [];
        const toggle = (m: number) => st.set({ reminderOffsetsMinutes: offsets.includes(m) ? offsets.filter((x) => x !== m) : [...offsets, m].sort((a, b) => b - a).slice(0, 4) });
        return (
          <div className="space-y-5">
            <Section title="Appointment reminders" description="Sent automatically before each appointment, up to four per booking." footer={saveButton(st, ['reminderOffsetsMinutes', 'quietHoursStart', 'quietHoursEnd'])}>
              <FormError message={st.error} />
              <div className="flex flex-wrap gap-2" role="group" aria-label="When to remind">
                {REMINDERS.map((r) => { const on = offsets.includes(r.minutes); return <button key={r.minutes} type="button" aria-pressed={on} onClick={() => toggle(r.minutes)} className={`rounded-full border px-3 py-1.5 text-sm max-md:min-h-10 ${on ? 'border-primary bg-primary-soft text-primary-soft-fg' : 'border-line hover:border-primary/50'}`}>{r.label}</button>; })}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="No messages after" hint="Quiet hours apply to reminders and promotions."><TimeInput value={hhmm(st.s.quietHoursStart)} onChange={(e) => st.set({ quietHoursStart: e.target.value })} /></Field>
                <Field label="Resume at"><TimeInput value={hhmm(st.s.quietHoursEnd)} onChange={(e) => st.set({ quietHoursEnd: e.target.value })} /></Field>
              </div>
              <p className="text-xs text-muted">Booking confirmations and receipts always go out straight away.</p>
            </Section>
            <Section title="Pending payment reminders" footer={saveButton(st, ['outstandingReminderEnabled', 'outstandingReminderMinAmount', 'outstandingReminderIntervalDays', 'outstandingReminderMaxPerMonth'])}>
              <Switch checked={st.s.outstandingReminderEnabled} onCheckedChange={(v) => st.set({ outstandingReminderEnabled: v })} label="Remind customers who owe money" description="Polite, limited reminders. Customers who opted out are never contacted." />
              {st.s.outstandingReminderEnabled && (
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Only if they owe at least"><MoneyInput value={st.s.outstandingReminderMinAmount} onChange={(m) => st.set({ outstandingReminderMinAmount: m ?? 0 })} /></Field>
                  <Field label="Wait between reminders"><Input type="number" min={1} max={90} suffix="days" value={st.s.outstandingReminderIntervalDays} onChange={(e) => st.set({ outstandingReminderIntervalDays: Number(e.target.value) })} /></Field>
                  <Field label="Most per month"><Input type="number" min={1} max={31} value={st.s.outstandingReminderMaxPerMonth} onChange={(e) => st.set({ outstandingReminderMaxPerMonth: Number(e.target.value) })} /></Field>
                </div>
              )}
            </Section>
            <InlineNotice tone="info">Edit the wording of every message under <Link className="font-medium text-primary hover:underline" to="/notifications/templates">Messages → Message templates</Link>.</InlineNotice>
          </div>
        );
      }}
    </SettingsShell>
  );
}

function PrivacyPanel() {
  const user = useUser();
  const isOwner = user.role?.key === 'owner';
  return (
    <SettingsShell>
      {(st) => (
        <div className="space-y-5">
          <Section title="What team members can see" footer={saveButton(st, ['staffCanViewCustomerPhone', 'staffCanViewOwnPerformance'])}>
            <FormError message={st.error} />
            <Switch checked={st.s.staffCanViewCustomerPhone} onCheckedChange={(v) => st.set({ staffCanViewCustomerPhone: v })} label="Team members can see customer phone numbers" description="Off: numbers are hidden for roles without the “see phone numbers and emails” permission." />
            <Switch checked={st.s.staffCanViewOwnPerformance} onCheckedChange={(v) => st.set({ staffCanViewOwnPerformance: v })} label="Team members can see their own monthly numbers" description="Shows appointments done and services worth on their My day screen." />
          </Section>
          <Section title="Two-step sign-in" description="After their password, people enter a 6-digit code from an authenticator app on their phone. It protects the accounts that can change money, settings and users." footer={isOwner ? saveButton(st, ['twoFactorRequirement']) : undefined}>
            <Field label="Who must use it" hint={isOwner ? 'Anyone can switch it on for themselves. People who are required are asked to set it up the next time they open the app.' : 'Only an owner can change this.'}>
              <Select disabled={!isOwner} value={st.s.twoFactorRequirement} onChange={(e) => st.set({ twoFactorRequirement: e.target.value as TwoFactorRequirement })}>
                {TWO_FACTOR_REQUIREMENTS.map((r) => <option key={r} value={r}>{TWO_FACTOR_REQUIREMENT_LABELS[r]}</option>)}
              </Select>
            </Field>
            {isOwner && st.s.twoFactorRequirement !== 'off' && !user.twoFactor.enabled && <InlineNotice tone="warning" title="You will be asked to set it up first">Because it will be required of owners, you will set up your own two-step sign-in as soon as you save.</InlineNotice>}
            <p className="text-sm text-muted">Set up your own under <Link className="font-medium text-primary hover:underline" to="/security">Account security</Link>. If someone loses their phone, an owner or user administrator can reset theirs from <Link className="font-medium text-primary hover:underline" to="/users">Users and roles</Link>.</p>
          </Section>
        </div>
      )}
    </SettingsShell>
  );
}
