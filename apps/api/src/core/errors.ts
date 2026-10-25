import type { ErrorCode, FieldIssue } from '@salon/shared';
import type { ZodError } from 'zod';

/** Expected, user-facing failure. `message` must be safe to show to a receptionist. */
export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const notFound = (what = 'Record') => new AppError(404, 'NOT_FOUND', `${what} could not be found.`);

export const forbidden = (message = "You don't have permission to do this. Ask your manager or salon owner for access.") =>
  new AppError(403, 'FORBIDDEN', message);

export const conflict = (code: ErrorCode, message: string, details?: Record<string, unknown>) =>
  new AppError(409, code, message, details);

export const unprocessable = (code: ErrorCode, message: string, details?: Record<string, unknown>) =>
  new AppError(422, code, message, details);

export function validationError(error: ZodError, message = 'Please check the highlighted fields.'): AppError {
  const issues: FieldIssue[] = error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
  return new AppError(400, 'VALIDATION_ERROR', message, { issues });
}

interface PgError {
  code?: string;
  constraint?: string;
  message?: string;
  detail?: string;
  table?: string;
}

/** Friendly messages for constraints that users can actually hit. Anything else falls back to a generic message. */
const CONSTRAINT_MESSAGES: Record<string, { code: ErrorCode; message: string; status?: number }> = {
  appointment_items_no_staff_overlap: {
    code: 'APPOINTMENT_CONFLICT',
    message: 'This team member was just booked for an overlapping time by someone else. Choose another time or team member.',
  },
  staff_time_blocks_no_overlap: { code: 'CONFLICT', message: 'This blocked time overlaps another blocked period.' },
  staff_shifts_no_overlap: { code: 'VALIDATION_ERROR', message: 'Two shifts on the same day overlap.', status: 400 },
  staff_breaks_no_overlap: { code: 'VALIDATION_ERROR', message: 'Two breaks on the same day overlap.', status: 400 },
  customers_mobile_unique: { code: 'DUPLICATE_CUSTOMER', message: 'This mobile number already belongs to another customer.' },
  customers_organization_id_customer_code_key: { code: 'DUPLICATE_RECORD', message: 'This customer code is already used.' },
  users_email_unique: { code: 'DUPLICATE_RECORD', message: 'This email address is already used by another login.' },
  users_phone_unique: { code: 'DUPLICATE_RECORD', message: 'This mobile number is already used by another login.' },
  staff_organization_id_employee_code_key: { code: 'DUPLICATE_RECORD', message: 'This employee code is already used.' },
  staff_punch_id_unique: { code: 'DUPLICATE_RECORD', message: 'This biometric punch ID is already mapped to another team member.' },
  staff_user_id_key: { code: 'DUPLICATE_RECORD', message: 'This login is already linked to another team member.' },
  services_organization_id_code_key: { code: 'DUPLICATE_RECORD', message: 'This service code is already used.' },
  packages_organization_id_code_key: { code: 'DUPLICATE_RECORD', message: 'This package code is already used.' },
  offers_code_unique: { code: 'DUPLICATE_RECORD', message: 'This offer code is already used.' },
  branches_organization_id_code_key: { code: 'DUPLICATE_RECORD', message: 'This branch code is already used.' },
  organizations_code_key: { code: 'DUPLICATE_RECORD', message: 'This salon code is already taken.' },
  expertise_name_unique: { code: 'DUPLICATE_RECORD', message: 'An expertise with this name already exists.' },
  service_categories_name_unique: { code: 'DUPLICATE_RECORD', message: 'A category with this name already exists.' },
  roles_organization_id_key_key: { code: 'DUPLICATE_RECORD', message: 'A role with this name already exists.' },
  holidays_unique_day: { code: 'DUPLICATE_RECORD', message: 'A holiday already exists on this date.' },
  invoices_one_per_appointment: { code: 'APPOINTMENT_ALREADY_BILLED', message: 'This appointment has already been billed.' },
  staff_schedule_overrides_staff_id_date_key: { code: 'DUPLICATE_RECORD', message: 'This day already has a schedule change.' },
  org_integrations_active_channel: { code: 'DUPLICATE_RECORD', message: 'A connection of this type already exists.' },
  attendance_days_staff_id_date_key: { code: 'DUPLICATE_RECORD', message: 'Attendance for this day already exists.' },
};

export function translateDatabaseError(error: unknown): AppError | null {
  const pg = error as PgError;
  if (!pg || typeof pg.code !== 'string') return null;
  const mapped = pg.constraint ? CONSTRAINT_MESSAGES[pg.constraint] : undefined;
  switch (pg.code) {
    case '23505':
      return new AppError(mapped?.status ?? 409, mapped?.code ?? 'DUPLICATE_RECORD', mapped?.message ?? 'This record already exists.', {
        constraint: pg.constraint,
      });
    case '23P01':
      return new AppError(mapped?.status ?? 409, mapped?.code ?? 'CONFLICT', mapped?.message ?? 'This overlaps an existing entry.', {
        constraint: pg.constraint,
      });
    case '23503':
      return new AppError(400, 'BAD_REQUEST', 'One of the selected items no longer exists or belongs to another salon.', {
        constraint: pg.constraint,
      });
    case '23514':
      return new AppError(400, 'VALIDATION_ERROR', mapped?.message ?? 'Some of the values are not allowed.', {
        constraint: pg.constraint,
      });
    case '22P02':
    case '22007':
    case '22008':
      return new AppError(400, 'BAD_REQUEST', 'Some of the values are in the wrong format.');
    case 'P0001':
      return new AppError(409, 'FINANCIAL_INTEGRITY', pg.message ?? 'This record cannot be changed.');
    case '40001':
    case '40P01':
    case '55P03':
      return new AppError(503, 'SERVICE_UNAVAILABLE', 'Someone else was updating the same record. Please try again.');
    case '57014':
      return new AppError(503, 'SERVICE_UNAVAILABLE', 'This took too long. Please try again or narrow your filters.');
    case '42501':
      return new AppError(403, 'FORBIDDEN', "You don't have permission to do this.");
    default:
      return null;
  }
}
