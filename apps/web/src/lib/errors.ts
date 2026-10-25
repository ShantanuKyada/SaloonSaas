import { ApiError } from './api';

// Errors must say what happened, why, and what to do next (requirement 86.13). The server already writes the
// "what and why" in plain language; this adds the "what next" so the UI can offer a useful action.

export interface FriendlyError {
  title: string;
  message: string;
  /** Plain-language next steps. */
  hints: string[];
  code: string;
}

const HINTS: Record<string, string[]> = {
  APPOINTMENT_CONFLICT: ['Choose another team member', 'Choose another time'],
  STAFF_ON_LEAVE: ['Choose another team member', 'Choose another day'],
  STAFF_NOT_WORKING: ['Choose another team member', 'Choose another day'],
  STAFF_UNAVAILABLE: ['Choose another team member', 'Choose another time'],
  STAFF_NOT_QUALIFIED: ['Choose a team member who offers this service'],
  OUTSIDE_WORKING_HOURS: ['Choose a time inside opening hours'],
  BRANCH_CLOSED: ['Choose another day'],
  BOOKING_IN_PAST: ['Choose a time that has not passed yet'],
  BOOKING_TOO_FAR: ['Choose an earlier date'],
  STALE_VERSION: ['Refresh to see the latest details, then try again'],
  DUPLICATE_CUSTOMER: ['Open the existing customer instead'],
  CREDIT_LIMIT_EXCEEDED: ['Collect some payment now', 'Ask a manager to approve credit'],
  INVOICE_NOT_PAYABLE: ['Refresh the list of pending bills'],
  PAYMENT_EXCEEDS_BALANCE: ['Lower the amount, or keep the extra as advance'],
  OFFER_INVALID: ['Remove the offer, or choose another one'],
  PACKAGE_UNAVAILABLE: ['Bill the service at its normal price instead'],
  RATE_LIMITED: ['Wait a minute, then try again'],
  NETWORK: ['Check your internet connection', 'Try again in a moment'],
  SESSION_EXPIRED: ['Sign in again'],
  INVALID_MFA_CODE: ['Use the newest code shown in your authenticator app', 'Or use one of your recovery codes'],
  MFA_SETUP_REQUIRED: ['Set up two-step sign-in to continue'],
  MFA_REQUIRED_BY_POLICY: ['Ask an owner to change the salon’s two-step sign-in setting first'],
  FORBIDDEN: ['Ask your manager or salon owner for access'],
  BRANCH_ACCESS_DENIED: ['Switch to a branch you work at'],
};

const TITLES: Record<string, string> = {
  APPOINTMENT_CONFLICT: 'That time is no longer free',
  VALIDATION_ERROR: 'Please check the details',
  NETWORK: "You're offline",
  FORBIDDEN: 'You don’t have access to this',
  INVALID_MFA_CODE: 'That code didn’t work',
  MFA_SETUP_REQUIRED: 'Set up two-step sign-in first',
  MFA_REQUIRED_BY_POLICY: 'Your salon requires two-step sign-in',
  NOT_FOUND: 'We couldn’t find that',
  DUPLICATE_CUSTOMER: 'This customer already exists',
  CREDIT_LIMIT_EXCEEDED: 'Credit limit reached',
  STALE_VERSION: 'This was just changed by someone else',
  RATE_LIMITED: 'Please slow down a little',
  INTERNAL_ERROR: 'Something went wrong on our side',
};

export function friendlyError(error: unknown): FriendlyError {
  if (error instanceof ApiError) {
    return {
      code: error.errorCode,
      title: TITLES[error.errorCode] ?? 'That didn’t work',
      message: error.message,
      hints: HINTS[error.errorCode] ?? [],
    };
  }
  return { code: 'UNKNOWN', title: 'Something went wrong', message: error instanceof Error ? error.message : 'Please try again.', hints: [] };
}

export const isApiError = (e: unknown, code?: string): e is ApiError => e instanceof ApiError && (!code || e.errorCode === code);
