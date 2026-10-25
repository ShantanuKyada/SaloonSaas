import { EMPLOYMENT_STATUS_LABELS, GENDER_LABELS } from '@salon/shared';
import { Mail, Pencil, Phone } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { Money } from '@/components/common/badges';
import { Button, ButtonLink } from '@/components/ui/button';
import { Avatar, Badge, Card, CardHeader, ErrorState, InlineNotice, PageHeader, Skeleton, TabPanel, Tabs } from '@/components/ui/display';
import { useCan } from '@/lib/auth';
import { fmtDateTime, fmtDay } from '@/lib/format';
import { useStaffDetail } from './hooks';
import { OneDayChanges } from './OneDayChanges';
import { StaffFormDrawer } from './StaffFormDrawer';
import { StaffServicesPanel } from './StaffServicesPanel';
import { WeeklyHoursEditor } from './WeeklyHoursEditor';

const TYPE_LABEL: Record<string, string> = { full_time: 'Full time', part_time: 'Part time', contract: 'Contract', freelance: 'Freelance' };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex justify-between gap-4 py-2 text-sm"><dt className="text-muted">{label}</dt><dd className="text-right font-medium">{children || <span className="font-normal text-faint">Not set</span>}</dd></div>;
}

export function Component() {
  const { id } = useParams();
  const can = useCan();
  const q = useStaffDetail(id);
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState(false);
  const tab = params.get('tab') ?? 'profile';

  if (q.isLoading) return <div role="status" aria-label="Loading team member" className="space-y-4"><Skeleton className="h-20" /><Skeleton className="h-64" /></div>;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const s = q.data;
  const manage = can('staff.manage');
  const schedule = can('staff.schedule');
  const workingDays = s.weeklySchedule.shifts.reduce((set, x) => set.add(x.weekday), new Set<number>()).size;

  return (
    <div className="space-y-5">
      <PageHeader
        back={<Link to="/staff" className="mb-1 inline-block text-sm text-muted hover:text-fg">← All team members</Link>}
        title={
          <span className="flex flex-wrap items-center gap-3">
            <Avatar name={s.displayName} color={s.calendarColor} src={s.photoUrl} size="lg" />
            <span>
              {s.fullName}
              <span className="block text-sm font-normal text-muted">{s.designation ?? 'Team member'} · {s.employeeCode} · {s.branch.name}</span>
            </span>
            <Badge tone={s.employmentStatus === 'active' ? 'success' : s.employmentStatus === 'on_notice' ? 'warning' : 'neutral'}>{EMPLOYMENT_STATUS_LABELS[s.employmentStatus]}</Badge>
          </span>
        }
        actions={<>
          {s.mobile && <ButtonLink to={`tel:${s.mobile}`} variant="outline" icon={<Phone className="size-4" />}>Call</ButtonLink>}
          {manage && <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Edit details</Button>}
        </>}
      />
      {s.isBookable && s.services.filter((x) => x.isActive).length === 0 && <InlineNotice tone="warning" title="No services assigned" action={manage && <Button size="sm" onClick={() => setParams({ tab: 'services' })}>Assign services</Button>}>Customers cannot book {s.displayName} until they have at least one service.</InlineNotice>}
      {s.isBookable && workingDays === 0 && <InlineNotice tone="warning" title="No working hours" action={schedule && <Button size="sm" onClick={() => setParams({ tab: 'hours' })}>Set hours</Button>}>{s.displayName} will not appear as available until working hours are set.</InlineNotice>}

      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })} tabs={[{ value: 'profile', label: 'Profile' }, { value: 'services', label: 'Services', badge: <Badge>{s.services.filter((x) => x.isActive).length}</Badge> }, { value: 'hours', label: 'Working hours' }]}>
        <TabPanel value="profile">
          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader title="Contact" />
              <dl className="divide-y divide-line">
                <Row label="Mobile">{s.mobile}</Row>
                <Row label="Email">{s.email && <span className="inline-flex items-center gap-1"><Mail className="size-3.5" aria-hidden />{s.email}</span>}</Row>
                <Row label="Gender">{GENDER_LABELS[s.gender as keyof typeof GENDER_LABELS]}</Row>
                {manage && <Row label="Birthday">{s.dateOfBirth && fmtDay(s.dateOfBirth, s.branch.timezone, true)}</Row>}
                {manage && <Row label="Address">{s.address}</Row>}
              </dl>
            </Card>
            <Card>
              <CardHeader title="Work" />
              <dl className="divide-y divide-line">
                <Row label="Type">{TYPE_LABEL[s.employmentType]}</Row>
                <Row label="Joined">{s.joiningDate && fmtDay(s.joiningDate, s.branch.timezone, true)}</Row>
                {s.exitDate && <Row label="Last day">{fmtDay(s.exitDate, s.branch.timezone, true)}</Row>}
                <Row label="Shown on calendar">{s.isBookable ? 'Yes' : 'No'}</Row>
                <Row label="Online booking">{s.onlineBookable && s.isBookable ? 'Customers can choose them' : 'Hidden'}</Row>
                <Row label="Biometric ID">{s.biometricPunchId}</Row>
                {manage && <Row label="Commission">{s.commissionType === 'percentage' ? `${(s.commissionValue ?? 0) / 100}% of service` : s.commissionType === 'flat' ? <><Money value={s.commissionValue} /> per service</> : 'None'}</Row>}
              </dl>
            </Card>
            <Card>
              <CardHeader title="Skills" description="Used to suggest the right person when booking." />
              {s.expertise.length ? <div className="flex flex-wrap gap-2">{s.expertise.map((e) => <Badge key={e.id} tone="primary">{e.name}</Badge>)}</div> : <p className="text-sm text-muted">No skills added yet.</p>}
            </Card>
            <Card>
              <CardHeader title="Sign-in access" />
              {s.login ? <dl className="divide-y divide-line"><Row label="Email">{s.login.email}</Row><Row label="Account">{s.login.status === 'active' ? 'Active' : 'Disabled'}</Row><Row label="Last signed in">{s.login.lastLoginAt ? fmtDateTime(s.login.lastLoginAt, s.branch.timezone) : 'Never'}</Row></dl> : <p className="text-sm text-muted">No login. Add a user under Users &amp; roles if they should see their own day on a phone.</p>}
            </Card>
            {manage && s.notes && <Card className="lg:col-span-2"><CardHeader title="Private notes" /><p className="whitespace-pre-wrap text-sm">{s.notes}</p></Card>}
          </div>
        </TabPanel>
        <TabPanel value="services"><StaffServicesPanel key={s.services.map((x) => `${x.serviceId}${x.isActive}`).join()} staff={s} canEdit={manage} /></TabPanel>
        <TabPanel value="hours">
          <div className="space-y-5">
            <Card>
              <CardHeader title="Weekly hours" description="Used for availability, the calendar and attendance expectations." />
              {schedule ? <WeeklyHoursEditor key={JSON.stringify(s.weeklySchedule)} staff={s} /> : <p className="text-sm text-muted">You can view but not change working hours.</p>}
            </Card>
            <OneDayChanges staffId={s.id} timezone={s.branch.timezone} canEdit={schedule} />
          </div>
        </TabPanel>
      </Tabs>
      {editing && <StaffFormDrawer staff={s} onClose={() => setEditing(false)} />}
    </div>
  );
}
