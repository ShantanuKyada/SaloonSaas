// Enumerations shared by the API, the database CHECK constraints and the UI.
// Labels are written in the salon's language (requirement 86.12), never in technical terms.

export const APPOINTMENT_STATUSES = [
  'waiting',
  'scheduled',
  'confirmed',
  'checked_in',
  'in_service',
  'completed',
  'cancelled',
  'no_show',
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const APPOINTMENT_STATUS_LABELS: Record<AppointmentStatus, string> = {
  waiting: 'Waiting',
  scheduled: 'Scheduled',
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  in_service: 'In service',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
};

/** Statuses whose service lines occupy the stylist's time. */
export const SCHEDULE_BLOCKING_STATUSES: readonly AppointmentStatus[] = [
  'scheduled',
  'confirmed',
  'checked_in',
  'in_service',
  'completed',
];

export const ACTIVE_APPOINTMENT_STATUSES: readonly AppointmentStatus[] = [
  'waiting',
  'scheduled',
  'confirmed',
  'checked_in',
  'in_service',
];

export const APPOINTMENT_SOURCES = ['phone', 'walk_in', 'in_person', 'online', 'whatsapp', 'social', 'other'] as const;
export type AppointmentSource = (typeof APPOINTMENT_SOURCES)[number];
export const APPOINTMENT_SOURCE_LABELS: Record<AppointmentSource, string> = {
  phone: 'Phone call',
  walk_in: 'Walk-in',
  in_person: 'At the desk',
  online: 'Online booking',
  whatsapp: 'WhatsApp',
  social: 'Social media',
  other: 'Other',
};

/** Walk-in board columns (DECISIONS B2): derived from appointment status + billing state. */
export const WALK_IN_STAGES = ['waiting', 'assigned', 'in_service', 'completed', 'billed'] as const;
export type WalkInStage = (typeof WALK_IN_STAGES)[number];
export const WALK_IN_STAGE_LABELS: Record<WalkInStage, string> = {
  waiting: 'Waiting',
  assigned: 'Assigned',
  in_service: 'In service',
  completed: 'Completed',
  billed: 'Billed',
};

export const PAYMENT_METHODS = ['cash', 'upi', 'card', 'bank_transfer', 'online', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  upi: 'UPI',
  card: 'Card',
  bank_transfer: 'Bank transfer',
  online: 'Online payment',
  other: 'Other',
};

export const PAYMENT_STATUSES = ['unpaid', 'partial', 'paid', 'void'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  unpaid: 'Pending payment',
  partial: 'Partly paid',
  paid: 'Paid',
  void: 'Cancelled',
};

export const LEDGER_ENTRY_TYPES = [
  'invoice',
  'payment',
  'refund',
  'credit_adjustment',
  'write_off',
  'discount',
  'invoice_void',
  'payment_void',
] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];
export const LEDGER_ENTRY_LABELS: Record<LedgerEntryType, string> = {
  invoice: 'Service bill',
  payment: 'Payment received',
  refund: 'Refund',
  credit_adjustment: 'Adjustment',
  write_off: 'Write-off',
  discount: 'Discount',
  invoice_void: 'Bill cancelled',
  payment_void: 'Payment cancelled',
};

export const ADJUSTMENT_TYPES = ['credit', 'write_off', 'discount'] as const;
export type AdjustmentType = (typeof ADJUSTMENT_TYPES)[number];

export const INVOICE_ITEM_TYPES = ['service', 'package_sale', 'package_redemption', 'custom'] as const;
export type InvoiceItemType = (typeof INVOICE_ITEM_TYPES)[number];

export const GENDERS = ['female', 'male', 'other', 'unspecified'] as const;
export type Gender = (typeof GENDERS)[number];
export const GENDER_LABELS: Record<Gender, string> = {
  female: 'Female',
  male: 'Male',
  other: 'Other',
  unspecified: 'Prefer not to say',
};

export const SERVICE_GENDERS = ['unisex', 'female', 'male'] as const;
export type ServiceGender = (typeof SERVICE_GENDERS)[number];

export const CUSTOMER_SOURCES = ['walk_in', 'phone', 'online', 'referral', 'social', 'import', 'other'] as const;
export type CustomerSource = (typeof CUSTOMER_SOURCES)[number];
export const CUSTOMER_SOURCE_LABELS: Record<CustomerSource, string> = {
  walk_in: 'Walked in',
  phone: 'Phone call',
  online: 'Online',
  referral: 'Referred by someone',
  social: 'Social media',
  import: 'Imported',
  other: 'Other',
};

export const RECORD_STATUSES = ['active', 'inactive', 'archived'] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

export const EMPLOYMENT_STATUSES = ['active', 'on_notice', 'inactive', 'terminated'] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];
export const EMPLOYMENT_STATUS_LABELS: Record<EmploymentStatus, string> = {
  active: 'Active',
  on_notice: 'On notice',
  inactive: 'Inactive',
  terminated: 'Left the salon',
};

export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'freelance'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const COMMISSION_TYPES = ['none', 'percentage', 'flat'] as const;
export type CommissionType = (typeof COMMISSION_TYPES)[number];

export const LEAVE_TYPES = ['casual', 'sick', 'earned', 'unpaid', 'other'] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];
export const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];
export const HALF_DAY_OPTIONS = ['none', 'first_half', 'second_half'] as const;
export type HalfDay = (typeof HALF_DAY_OPTIONS)[number];

export const NOTIFICATION_CHANNELS = ['whatsapp', 'email', 'sms'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export const NOTIFICATION_CHANNEL_LABELS: Record<NotificationChannel, string> = {
  whatsapp: 'WhatsApp',
  email: 'Email',
  sms: 'SMS',
};

export const NOTIFICATION_CATEGORIES = ['appointment', 'reminder', 'offers', 'outstanding', 'receipt'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];
export const NOTIFICATION_CATEGORY_LABELS: Record<NotificationCategory, string> = {
  appointment: 'Booking updates',
  reminder: 'Appointment reminders',
  offers: 'Offers & promotions',
  outstanding: 'Pending payment reminders',
  receipt: 'Payment receipts',
};
/** Marketing categories need explicit consent; the rest are transactional (DECISIONS B16). */
export const MARKETING_CATEGORIES: readonly NotificationCategory[] = ['offers'];

export const NOTIFICATION_EVENT_TYPES = [
  'appointment_confirmation',
  'appointment_reminder',
  'appointment_cancellation',
  'appointment_rescheduled',
  'payment_receipt',
  'outstanding_reminder',
  'offer',
  'birthday',
  're_engagement',
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];
export const NOTIFICATION_EVENT_LABELS: Record<NotificationEventType, string> = {
  appointment_confirmation: 'Booking confirmation',
  appointment_reminder: 'Appointment reminder',
  appointment_cancellation: 'Booking cancelled',
  appointment_rescheduled: 'Booking moved',
  payment_receipt: 'Payment receipt',
  outstanding_reminder: 'Pending payment reminder',
  offer: 'Offer',
  birthday: 'Birthday wishes',
  re_engagement: 'We miss you',
};
export const NOTIFICATION_EVENT_CATEGORY: Record<NotificationEventType, NotificationCategory> = {
  appointment_confirmation: 'appointment',
  appointment_reminder: 'reminder',
  appointment_cancellation: 'appointment',
  appointment_rescheduled: 'appointment',
  payment_receipt: 'receipt',
  outstanding_reminder: 'outstanding',
  offer: 'offers',
  birthday: 'offers',
  re_engagement: 'offers',
};

export const NOTIFICATION_STATUSES = [
  'queued',
  'processing',
  'sent',
  'delivered',
  'read',
  'failed',
  'cancelled',
  'skipped',
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const ATTENDANCE_STATUSES = [
  'present',
  'late',
  'absent',
  'half_day',
  'on_leave',
  'weekly_off',
  'holiday',
  'missing_punch',
  'not_started',
] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];
export const ATTENDANCE_STATUS_LABELS: Record<AttendanceStatus, string> = {
  present: 'Present',
  late: 'Late',
  absent: 'Absent',
  half_day: 'Half day',
  on_leave: 'On leave',
  weekly_off: 'Weekly off',
  holiday: 'Holiday',
  missing_punch: 'Missing punch',
  not_started: 'Not in yet',
};

export const OFFER_DISCOUNT_TYPES = ['percentage', 'flat'] as const;
export type OfferDiscountType = (typeof OFFER_DISCOUNT_TYPES)[number];
export const OFFER_SCOPES = ['all_services', 'services', 'categories', 'combo'] as const;
export type OfferScope = (typeof OFFER_SCOPES)[number];
export const OFFER_ELIGIBILITY = ['all', 'first_visit', 'birthday', 'loyalty', 'specific_customers'] as const;
export type OfferEligibility = (typeof OFFER_ELIGIBILITY)[number];
export const OFFER_ELIGIBILITY_LABELS: Record<OfferEligibility, string> = {
  all: 'All customers',
  first_visit: 'First visit only',
  birthday: 'Birthday week',
  loyalty: 'Loyal customers',
  specific_customers: 'Selected customers',
};

export const PACKAGE_SEGMENTS = ['all', 'new_customers', 'existing_customers'] as const;
export type PackageSegment = (typeof PACKAGE_SEGMENTS)[number];

/** Who must use two-step sign-in. Owners always means the Owner role; managers means anyone with the powers in MANAGER_PERMISSIONS. */
export const TWO_FACTOR_REQUIREMENTS = ['off', 'owners', 'owners_and_managers'] as const;
export type TwoFactorRequirement = (typeof TWO_FACTOR_REQUIREMENTS)[number];
export const TWO_FACTOR_REQUIREMENT_LABELS: Record<TwoFactorRequirement, string> = {
  off: 'Optional for everyone',
  owners: 'Required for owners',
  owners_and_managers: 'Required for owners and managers',
};

export const HOME_SCREENS = ['owner_dashboard', 'branch_dashboard', 'front_desk', 'my_day'] as const;
export type HomeScreen = (typeof HOME_SCREENS)[number];

export const INTEGRATION_KINDS = ['whatsapp', 'email', 'sms', 'biometric', 'payment_gateway'] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export const WEEKDAY_LABELS: Record<number, string> = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday',
};
export const WEEKDAY_SHORT: Record<number, string> = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' };

export const AGEING_BUCKETS = [
  { key: 'd0_30', label: '0–30 days', min: 0, max: 30 },
  { key: 'd31_60', label: '31–60 days', min: 31, max: 60 },
  { key: 'd61_90', label: '61–90 days', min: 61, max: 90 },
  { key: 'd90_plus', label: '90+ days', min: 91, max: null },
] as const;
export type AgeingBucketKey = (typeof AGEING_BUCKETS)[number]['key'];

export const PAGE_SIZE_DEFAULT = 25;
export const PAGE_SIZE_MAX = 100;
