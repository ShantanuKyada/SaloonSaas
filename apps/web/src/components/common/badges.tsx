import { APPOINTMENT_STATUS_LABELS, ATTENDANCE_STATUS_LABELS, PAYMENT_STATUS_LABELS, WALK_IN_STAGE_LABELS, type AppointmentStatus, type AttendanceStatus, type PaymentStatus, type WalkInStage } from '@salon/shared';
import { Badge, type Tone } from '@/components/ui/display';
import { useBranch } from '@/lib/branch';
import { money } from '@/lib/format';

export const APPOINTMENT_TONE: Record<AppointmentStatus, Tone> = {
  waiting: 'warning',
  scheduled: 'info',
  confirmed: 'primary',
  checked_in: 'warning',
  in_service: 'success',
  completed: 'neutral',
  cancelled: 'neutral',
  no_show: 'danger',
};

export function StatusBadge({ status }: { status: AppointmentStatus }) {
  return (
    <Badge tone={APPOINTMENT_TONE[status]} dot>
      {APPOINTMENT_STATUS_LABELS[status]}
    </Badge>
  );
}

const PAY_TONE: Record<PaymentStatus, Tone> = { unpaid: 'danger', partial: 'warning', paid: 'success', void: 'neutral' };
export function PaymentBadge({ status }: { status: PaymentStatus }) {
  return <Badge tone={PAY_TONE[status]}>{PAYMENT_STATUS_LABELS[status]}</Badge>;
}

const STAGE_TONE: Record<WalkInStage, Tone> = { waiting: 'warning', assigned: 'info', in_service: 'success', completed: 'neutral', billed: 'primary' };
export function StageBadge({ stage }: { stage: WalkInStage }) {
  return <Badge tone={STAGE_TONE[stage]}>{WALK_IN_STAGE_LABELS[stage]}</Badge>;
}

const ATT_TONE: Record<AttendanceStatus, Tone> = { present: 'success', late: 'warning', absent: 'danger', half_day: 'warning', on_leave: 'info', weekly_off: 'neutral', holiday: 'neutral', missing_punch: 'warning', not_started: 'neutral' };
export function AttendanceBadge({ status }: { status: AttendanceStatus }) {
  return <Badge tone={ATT_TONE[status]}>{ATTENDANCE_STATUS_LABELS[status]}</Badge>;
}

/** Amount in the salon's currency. */
export function Money({ value, className, muted }: { value: number | null | undefined; className?: string; muted?: boolean }) {
  const { currency } = useBranch();
  return <span className={`tabular-nums ${muted ? 'text-muted' : ''} ${className ?? ''}`}>{money(value, currency)}</span>;
}

export function useMoney() {
  const { currency } = useBranch();
  return (minor: number | null | undefined) => money(minor, currency);
}

/** A clear, non-blocking "₹3,500 pending" marker (requirement 86.14). */
export function PendingChip({ amount }: { amount: number }) {
  const m = useMoney();
  if (amount <= 0) return null;
  return (
    <Badge tone="warning" className="font-semibold">
      {m(amount)} pending
    </Badge>
  );
}
