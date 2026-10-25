import type { AppointmentStatus, WalkInStage } from './constants.js';

/**
 * Allowed status changes. Backwards moves exist only as safe "undo" steps (e.g. restore a cancelled booking,
 * undo a check-in); the API re-validates availability before restoring anything that blocks a stylist's time.
 */
export const APPOINTMENT_TRANSITIONS: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  waiting: ['checked_in', 'in_service', 'cancelled'],
  scheduled: ['confirmed', 'checked_in', 'in_service', 'cancelled', 'no_show'],
  confirmed: ['scheduled', 'checked_in', 'in_service', 'cancelled', 'no_show'],
  checked_in: ['in_service', 'confirmed', 'cancelled'],
  in_service: ['completed', 'checked_in'],
  completed: ['in_service'],
  cancelled: ['scheduled'],
  no_show: ['scheduled'],
};

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return APPOINTMENT_TRANSITIONS[from].includes(to);
}

/** Human labels for the action that moves an appointment into `to`. */
export const TRANSITION_ACTION_LABELS: Partial<Record<AppointmentStatus, string>> = {
  confirmed: 'Confirm',
  checked_in: 'Check in',
  in_service: 'Start service',
  completed: 'Complete',
  cancelled: 'Cancel',
  no_show: 'Mark no-show',
  scheduled: 'Restore',
};

export function walkInStage(status: AppointmentStatus, billed: boolean): WalkInStage | null {
  if (billed) return 'billed';
  switch (status) {
    case 'waiting':
      return 'waiting';
    case 'scheduled':
    case 'confirmed':
    case 'checked_in':
      return 'assigned';
    case 'in_service':
      return 'in_service';
    case 'completed':
      return 'completed';
    default:
      return null;
  }
}
