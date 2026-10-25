// Stable machine-readable error codes returned in `{ success: false, errorCode }`.
// The UI maps some of them to recovery actions (e.g. APPOINTMENT_CONFLICT → "Choose another time").

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'ACCOUNT_LOCKED',
  'ACCOUNT_DISABLED',
  'INVALID_MFA_CODE',
  'MFA_SETUP_REQUIRED',
  'MFA_REQUIRED_BY_POLICY',
  'SESSION_EXPIRED',
  'FORBIDDEN',
  'BRANCH_ACCESS_DENIED',
  'NOT_FOUND',
  'CONFLICT',
  'STALE_VERSION',
  'DUPLICATE_CUSTOMER',
  'DUPLICATE_RECORD',
  'APPOINTMENT_CONFLICT',
  'STAFF_NOT_QUALIFIED',
  'STAFF_ON_LEAVE',
  'STAFF_NOT_WORKING',
  'STAFF_UNAVAILABLE',
  'OUTSIDE_WORKING_HOURS',
  'BRANCH_CLOSED',
  'BOOKING_IN_PAST',
  'BOOKING_TOO_FAR',
  'INVALID_STATUS_TRANSITION',
  'APPOINTMENT_ALREADY_BILLED',
  'CREDIT_LIMIT_EXCEEDED',
  'OFFER_INVALID',
  'PACKAGE_UNAVAILABLE',
  'PAYMENT_EXCEEDS_BALANCE',
  'INVOICE_NOT_PAYABLE',
  'FINANCIAL_INTEGRITY',
  'IDEMPOTENCY_CONFLICT',
  'RATE_LIMITED',
  'INTEGRATION_ERROR',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  success: false;
  message: string;
  errorCode: ErrorCode;
  details: Record<string, unknown>;
  requestId?: string;
}

export interface ApiSuccessBody<T> {
  success: true;
  data: T;
  meta?: PageMeta;
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface FieldIssue {
  path: string;
  message: string;
}
