import type { SalonNow } from '@salon/shared';
import { Armchair, Clock, UserCheck, UserX, Users } from 'lucide-react';
import { Badge, Card, CardHeader, type Tone } from '@/components/ui/display';
import { cn } from '@/lib/utils';

const STATE_TONE: Record<SalonNow['staff'][number]['state'], { tone: Tone; label: string }> = {
  available: { tone: 'success', label: 'Free' },
  serving: { tone: 'primary', label: 'With a customer' },
  break: { tone: 'warning', label: 'On break' },
  blocked: { tone: 'warning', label: 'Blocked' },
  absent: { tone: 'danger', label: 'Not in' },
  on_leave: { tone: 'info', label: 'On leave' },
  off: { tone: 'neutral', label: 'Off now' },
};

export function Tile({ icon, label, value, tone = 'neutral', hint }: { icon: React.ReactNode; label: string; value: React.ReactNode; tone?: Tone; hint?: string }) {
  const bg = { neutral: 'bg-surface-3 text-muted', primary: 'bg-primary-soft text-primary-soft-fg', success: 'bg-success-soft text-success', warning: 'bg-warning-soft text-warning', danger: 'bg-danger-soft text-danger', info: 'bg-info-soft text-info' }[tone];
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3 shadow-card">
      <span className={cn('grid size-10 shrink-0 place-items-center rounded-lg', bg)}>{icon}</span>
      <div className="min-w-0">
        <p className="text-2xl font-semibold leading-none tabular-nums text-fg">{value}</p>
        <p className="mt-1 truncate text-xs text-muted">{label}</p>
        {hint && <p className="truncate text-[11px] text-faint">{hint}</p>}
      </div>
    </div>
  );
}

/** "What's happening right now?" understood in seconds (requirement 86.10). */
export function SalonNowTiles({ now }: { now: Pick<SalonNow, 'customersToday' | 'staffAvailable' | 'staffServing' | 'waitingCustomers' | 'upcomingAppointments' | 'staffAbsent' | 'staffOnLeave' | 'staffOnBreak' | 'completedToday'> }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <Tile icon={<Users className="size-5" />} label="Customers today" value={now.customersToday} tone="primary" hint={`${now.completedToday} done`} />
      <Tile icon={<UserCheck className="size-5" />} label="Team free now" value={now.staffAvailable} tone="success" />
      <Tile icon={<Armchair className="size-5" />} label="With customers" value={now.staffServing} tone="primary" />
      <Tile icon={<Clock className="size-5" />} label="Waiting" value={now.waitingCustomers} tone={now.waitingCustomers > 0 ? 'warning' : 'neutral'} />
      <Tile icon={<Clock className="size-5" />} label="Coming up" value={now.upcomingAppointments} tone="info" />
      <Tile icon={<UserX className="size-5" />} label="Away today" value={now.staffAbsent + now.staffOnLeave} tone={now.staffAbsent > 0 ? 'danger' : 'neutral'} hint={now.staffOnBreak ? `${now.staffOnBreak} on break` : undefined} />
    </div>
  );
}

export function StaffNowList({ staff, title = 'Team right now' }: { staff: SalonNow['staff']; title?: string }) {
  const order = { available: 0, serving: 1, break: 2, blocked: 3, absent: 4, on_leave: 5, off: 6 } as const;
  const sorted = [...staff].sort((a, b) => order[a.state] - order[b.state] || a.displayName.localeCompare(b.displayName));
  return (
    <Card>
      <CardHeader title={title} />
      {sorted.length === 0 ? (
        <p className="text-sm text-muted">No team members are set up yet.</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          {sorted.map((s) => (
            <li key={s.staffId} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="size-3 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{s.displayName}</span>
                  <span className="block truncate text-xs text-muted">{s.label}</span>
                </span>
              </span>
              <Badge tone={STATE_TONE[s.state].tone} dot>{STATE_TONE[s.state].label}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
