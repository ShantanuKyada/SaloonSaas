import { WEEKDAYS, WEEKDAY_SHORT } from '@salon/shared';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Badge, Card, EmptyState, ErrorState, PageHeader, Skeleton, TabPanel, Tabs } from '@/components/ui/display';
import { Avatar } from '@/components/ui/display';
import { Drawer } from '@/components/ui/overlay';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { useStaffList } from '@/lib/queries';
import { LeavePanel } from './LeavePanel';
import { TimeBlocksPanel } from './TimeBlocksPanel';
import { useStaffDetails, type StaffDetail } from './hooks';
import { WeeklyHoursEditor } from './WeeklyHoursEditor';

const hoursOn = (s: StaffDetail, weekday: number) => {
  const shifts = s.weeklySchedule.shifts.filter((x) => x.weekday === weekday);
  return shifts.length ? shifts.map((x) => `${x.startTime}–${x.endTime}`).join(', ') : null;
};

function WeeklyOverview() {
  const { scopeBranchId } = useBranch();
  const canEdit = useCan()('staff.schedule');
  const staff = useStaffList(scopeBranchId, { bookableOnly: false });
  const { details, loading, error } = useStaffDetails((staff.data ?? []).map((s) => s.id));
  const [editing, setEditing] = useState<StaffDetail | null>(null);
  if (staff.isLoading || loading) return <div role="status" aria-label="Loading schedules" className="space-y-2"><Skeleton className="h-12" /><Skeleton className="h-12" /><Skeleton className="h-12" /></div>;
  if (staff.isError || error) return <ErrorState error={staff.error ?? error} onRetry={() => void staff.refetch()} />;
  if (details.length === 0) return <Card><EmptyState title="No team members yet" description="Add your team first, then set their working hours." /></Card>;
  const today = new Date().getDay() || 7;
  return (
    <>
      <Card padded={false}>
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <caption className="sr-only">Weekly working hours for each team member</caption>
            <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted"><th scope="col" className="px-4 py-2.5 font-medium">Team member</th>{WEEKDAYS.map((d) => <th scope="col" key={d} className={`px-3 py-2.5 font-medium ${d === today ? 'text-primary' : ''}`}>{WEEKDAY_SHORT[d]}</th>)}</tr></thead>
            <tbody>
              {details.map((s) => (
                <tr key={s.id} className={`border-b border-line last:border-0 ${canEdit ? 'cursor-pointer hover:bg-surface-2/60' : ''}`} onClick={canEdit ? () => setEditing(s) : undefined}>
                  <th scope="row" className="px-4 py-2.5 text-left font-normal"><span className="flex items-center gap-2.5"><Avatar name={s.displayName} color={s.calendarColor} src={s.photoUrl} size="sm" /><span><span className="block font-medium">{s.displayName}</span>{!s.isBookable && <span className="text-xs text-muted">Not on calendar</span>}</span></span></th>
                  {WEEKDAYS.map((d) => { const w = hoursOn(s, d); return <td key={d} className="whitespace-nowrap px-3 py-2.5 tabular-nums">{w ?? <Badge>Off</Badge>}</td>; })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {canEdit && <p className="mt-2 text-xs text-muted">Select a row to change that person’s working hours and breaks.</p>}
      {editing && (
        <Drawer open onOpenChange={(o) => !o && setEditing(null)} title={`${editing.displayName}’s working hours`} size="lg">
          <WeeklyHoursEditor staff={editing} onSaved={() => setEditing(null)} />
        </Drawer>
      )}
    </>
  );
}

export function Component() {
  const [params, setParams] = useSearchParams();
  const { branches, scopeBranchId } = useBranch();
  const tab = params.get('tab') ?? 'hours';
  return (
    <div>
      <PageHeader title="Schedules and leave" description="Who works when, who is away, and time that cannot be booked." />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })} tabs={[{ value: 'hours', label: 'Weekly hours' }, { value: 'leave', label: 'Leave' }, { value: 'blocks', label: 'Blocked time' }]}>
        <TabPanel value="hours"><WeeklyOverview /></TabPanel>
        <TabPanel value="leave"><LeavePanel /></TabPanel>
        <TabPanel value="blocks">{branches.length > 1 && !scopeBranchId ? <Card><EmptyState title="Choose a branch" description="Blocked time belongs to one branch. Pick a branch from the selector at the top." /></Card> : <TimeBlocksPanel />}</TabPanel>
      </Tabs>
    </div>
  );
}
