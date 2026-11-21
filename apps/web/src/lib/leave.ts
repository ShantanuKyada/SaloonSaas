import type { LeaveStatus } from '@salon/shared';
import type { Tone } from '@/components/ui/display';

// Shared wording for leave, so team members and managers see the same words.
export const LEAVE_TYPE_LABEL: Record<string, string> = { casual: 'Casual leave', sick: 'Sick leave', earned: 'Earned leave', unpaid: 'Unpaid leave', other: 'Other' };
export const HALF_DAY_LABEL: Record<string, string> = { none: 'Full day', first_half: 'First half', second_half: 'Second half' };
export const LEAVE_STATUS: Record<LeaveStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Waiting for approval', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Declined', tone: 'danger' },
  cancelled: { label: 'Withdrawn', tone: 'neutral' },
};
