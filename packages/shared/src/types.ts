// Response DTOs returned by the API. Money is minor units; instants are ISO-8601 UTC strings; dates are YYYY-MM-DD.
import type {
  AppointmentSource,
  AppointmentStatus,
  AttendanceStatus,
  CustomerSource,
  EmploymentStatus,
  Gender,
  HomeScreen,
  LedgerEntryType,
  NotificationCategory,
  NotificationChannel,
  NotificationEventType,
  NotificationStatus,
  PaymentMethod,
  PaymentStatus,
  WalkInStage,
} from './constants.js';
import type { Permission } from './permissions.js';

// ───────────── Session ─────────────
export interface BranchSummary {
  id: string;
  code: string;
  name: string;
  timezone: string;
  status: string;
  phone: string | null;
}

export interface OrganizationSummary {
  id: string;
  code: string;
  name: string;
  currency: string;
  timezone: string;
  country: string;
  taxLabel: string;
  logoUrl: string | null;
  onboardingCompleted: boolean;
}

export interface SessionUser {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  isPlatformAdmin: boolean;
  organization: OrganizationSummary | null;
  role: { id: string; key: string; name: string; homeScreen: HomeScreen } | null;
  permissions: Permission[];
  allBranches: boolean;
  branches: BranchSummary[];
  staffId: string | null;
  mustChangePassword: boolean;
  twoFactor: TwoFactorState;
  preferences: {
    staffCanViewCustomerPhone: boolean;
    staffCanViewOwnPerformance: boolean;
    slotIntervalMinutes: number;
    pricesIncludeTax: boolean;
    defaultTaxRateBp: number;
    roundOffToMinor: number;
  } | null;
}

export interface TwoFactorState {
  /** This person has two-step sign-in switched on. */
  enabled: boolean;
  /** The salon's policy applies to this person's role. */
  required: boolean;
  /** Required but not set up yet: the app only lets them finish setting it up. */
  setupRequired: boolean;
  recoveryCodesLeft: number;
}

/** Returned instead of a session when the password was right but a second step is needed. */
export interface MfaChallenge {
  mfaRequired: true;
  mfaToken: string;
  expiresIn: number;
}

export interface TwoFactorSetup {
  /** Shared secret in base32, for typing into an authenticator app by hand. */
  secret: string;
  /** otpauth:// address the QR code encodes. */
  otpauthUrl: string;
}

export interface LoginResponse {
  accessToken: string;
  expiresIn: number;
  user: SessionUser;
}

// ───────────── Customers ─────────────
export interface CustomerListItem {
  id: string;
  customerCode: string;
  fullName: string;
  mobile: string | null;
  email: string | null;
  gender: Gender;
  status: string;
  tags: string[];
  registeredAt: string;
  lastVisitAt: string | null;
  visitCount: number;
  lifetimeSpend: number;
  outstanding: number;
  marketingConsent: boolean;
}

export interface CustomerSearchResult {
  id: string;
  customerCode: string;
  fullName: string;
  mobile: string | null;
  email: string | null;
  lastVisitAt: string | null;
  favoriteService: string | null;
  favoriteStaff: { id: string; name: string } | null;
  outstanding: number;
  upcomingAppointment: { id: string; startAt: string; branchName: string; services: string } | null;
}

export interface CustomerDetail {
  id: string;
  customerCode: string;
  fullName: string;
  mobile: string | null;
  whatsappNumber: string | null;
  email: string | null;
  gender: Gender;
  dateOfBirth: string | null;
  anniversaryDate: string | null;
  address: string | null;
  city: string | null;
  preferredBranchId: string | null;
  preferredStaffId: string | null;
  registeredBranchId: string | null;
  source: CustomerSource;
  referredBy: { id: string; fullName: string } | null;
  notes: string | null;
  tags: string[];
  creditLimit: number | null;
  marketingConsent: boolean;
  marketingConsentAt: string | null;
  status: string;
  registeredAt: string;
  contactMasked: boolean;
  preferences: Array<{ channel: NotificationChannel; category: NotificationCategory; enabled: boolean }>;
}

export interface Customer360 {
  customer: CustomerDetail;
  stats: {
    visitCount: number;
    lifetimeSpend: number;
    averageVisitValue: number;
    firstVisitAt: string | null;
    lastVisitAt: string | null;
    daysSinceLastVisit: number | null;
    cancelledCount: number;
    noShowCount: number;
    favoriteService: { id: string; name: string; count: number } | null;
    favoriteStaff: { id: string; name: string; count: number } | null;
    visitsPerMonth: number | null;
  };
  account: {
    balance: number;
    outstanding: number;
    advance: number;
    creditLimit: number | null;
    availableCredit: number | null;
    otherBranchesOutstanding: number;
  };
  upcoming: AppointmentSummary[];
  recentAppointments: AppointmentSummary[];
  topServices: Array<{ serviceId: string; name: string; count: number; spend: number }>;
  staffUsed: Array<{ staffId: string; name: string; count: number; lastAt: string }>;
  invoices: InvoiceSummary[];
  payments: PaymentSummary[];
  packages: CustomerPackageDto[];
  offersUsed: Array<{ offerId: string; name: string; discount: number; invoiceNumber: string; redeemedAt: string }>;
  communications: NotificationLogItem[];
  suggestion: { serviceId: string; serviceName: string; staffId: string | null; staffName: string | null; weekday: number | null; hour: number | null } | null;
}

// ───────────── Catalogue & staff ─────────────
export interface ServiceDto {
  id: string;
  categoryId: string;
  categoryName: string;
  categoryColor: string;
  code: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  bufferMinutes: number;
  price: number;
  taxRateBp: number | null;
  gender: string;
  allBranches: boolean;
  branches: Array<{ branchId: string; priceOverride: number | null }>;
  expertiseIds: string[];
  onlineBookable: boolean;
  sortOrder: number;
  status: string;
  qualifiedStaffCount: number;
  bookingsLast30Days?: number;
}

export interface StaffListItem {
  id: string;
  employeeCode: string;
  fullName: string;
  displayName: string;
  branchId: string;
  branchName: string;
  designation: string | null;
  mobile: string | null;
  employmentStatus: EmploymentStatus;
  isBookable: boolean;
  calendarColor: string;
  photoUrl: string | null;
  expertise: Array<{ id: string; name: string }>;
  serviceCount: number;
  hasLogin: boolean;
  biometricPunchId: string | null;
}

// ───────────── Scheduling ─────────────
export type StaffAvailabilityState =
  | 'available'
  | 'busy'
  | 'on_leave'
  | 'not_working'
  | 'not_qualified'
  | 'blocked'
  | 'outside_hours';

export interface StaffAvailability {
  staffId: string;
  displayName: string;
  color: string;
  state: StaffAvailabilityState;
  /** Plain-language status, e.g. "Busy until 11:30". */
  label: string;
  nextFreeAt: string | null;
  isPreferred: boolean;
  slots: string[];
  durationMinutes: number;
  price: number;
}

export interface AvailabilityResult {
  date: string;
  timezone: string;
  slotIntervalMinutes: number;
  branchOpen: boolean;
  branchHours: { open: string; close: string } | null;
  holiday: string | null;
  /** Set when the day is further ahead than the salon allows bookings (no times are offered). */
  beyondBookingWindowDays: number | null;
  totalDurationMinutes: number;
  staff: StaffAvailability[];
  /** Union of all slots with the staff who can take each one. */
  slots: Array<{ startAt: string; staffIds: string[] }>;
}

// ───────────── Appointments ─────────────
export interface AppointmentItemDto {
  id: string;
  serviceId: string;
  serviceName: string;
  categoryColor: string;
  staffId: string | null;
  staffName: string | null;
  staffColor: string | null;
  startAt: string | null;
  endAt: string | null;
  durationMinutes: number;
  bufferMinutes: number;
  price: number;
  status: string;
  customerPackageItemId: string | null;
}

export interface AppointmentDto {
  id: string;
  bookingNumber: string;
  branchId: string;
  branchName: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  localDate: string;
  startAt: string | null;
  endAt: string | null;
  queueNumber: number | null;
  totalDurationMinutes: number;
  estimatedAmount: number;
  customer: { id: string; fullName: string; mobile: string | null; customerCode: string; outstanding: number };
  items: AppointmentItemDto[];
  notes: string | null;
  internalNotes: string | null;
  arrivedAt: string | null;
  checkedInAt: string | null;
  serviceStartedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  rescheduleCount: number;
  invoiceId: string | null;
  invoiceNumber: string | null;
  paymentStatus: PaymentStatus | null;
  walkInStage: WalkInStage | null;
  version: number;
  createdAt: string;
  createdByName: string | null;
}

export interface AppointmentSummary {
  id: string;
  bookingNumber: string;
  status: AppointmentStatus;
  startAt: string | null;
  branchName: string;
  services: string;
  staff: string;
  amount: number;
}

export interface AppointmentEventDto {
  id: number;
  eventType: string;
  fromStatus: string | null;
  toStatus: string | null;
  data: Record<string, unknown> | null;
  actorName: string | null;
  createdAt: string;
}

export interface CalendarResource {
  staffId: string;
  displayName: string;
  color: string;
  photoUrl: string | null;
  shifts: Array<{ date: string; start: string; end: string }>;
  breaks: Array<{ date: string; start: string; end: string; label: string }>;
  blocks: Array<{ id: string; start: string; end: string; reason: string }>;
  leave: Array<{ date: string; halfDay: string; leaveType: string }>;
  attendance: AttendanceStatus | null;
}

export interface CalendarData {
  branchId: string;
  timezone: string;
  from: string;
  to: string;
  branchHours: Array<{ weekday: number; isClosed: boolean; openTime: string | null; closeTime: string | null }>;
  holidays: Array<{ date: string; name: string }>;
  resources: CalendarResource[];
  appointments: AppointmentDto[];
}

// ───────────── Billing ─────────────
export interface InvoiceSummary {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  branchName: string;
  customerName: string;
  customerId: string;
  grandTotal: number;
  amountPaid: number;
  amountAdjusted: number;
  balanceDue: number;
  paymentStatus: PaymentStatus;
  status: 'issued' | 'void';
}

export interface InvoiceLineDto {
  id: string;
  lineNo: number;
  itemType: string;
  description: string;
  serviceId: string | null;
  staffId: string | null;
  staffName: string | null;
  quantity: number;
  unitPrice: number;
  grossAmount: number;
  discountAmount: number;
  taxRateBp: number;
  taxableAmount: number;
  taxAmount: number;
  lineTotal: number;
}

export interface InvoiceDto extends InvoiceSummary {
  branchId: string;
  branch: { name: string; address: string | null; phone: string | null };
  organization: { name: string; legalName: string | null; taxId: string | null; taxLabel: string; currency: string; receiptFooter: string | null };
  customer: { id: string; fullName: string; mobile: string | null; customerCode: string };
  appointmentId: string | null;
  issuedAt: string;
  dueDate: string | null;
  pricesIncludeTax: boolean;
  subtotal: number;
  discountTotal: number;
  offerDiscount: number;
  offerName: string | null;
  manualDiscount: number;
  manualDiscountReason: string | null;
  taxTotal: number;
  roundOff: number;
  notes: string | null;
  lines: InvoiceLineDto[];
  payments: Array<{ paymentId: string; receiptNumber: string; method: PaymentMethod; amount: number; receivedAt: string }>;
  adjustments: Array<{ id: string; adjustmentNumber: string; type: string; amount: number; reason: string; createdAt: string }>;
  createdByName: string;
  voidedAt: string | null;
  voidReason: string | null;
}

export interface InvoicePreview {
  lines: Array<{
    key: string;
    description: string;
    itemType: string;
    quantity: number;
    unitPrice: number;
    gross: number;
    discount: number;
    taxRateBp: number;
    tax: number;
    total: number;
    staffId: string | null;
  }>;
  subtotal: number;
  offerDiscount: number;
  manualDiscount: number;
  discountTotal: number;
  taxTotal: number;
  roundOff: number;
  grandTotal: number;
  offer: { id: string; name: string; code: string | null } | null;
  offerMessage: string | null;
  applicableOffers: Array<{ id: string; name: string; code: string | null; estimatedDiscount: number; autoApply: boolean }>;
  customerAccount: { outstanding: number; advance: number; creditLimit: number | null; availableCredit: number | null };
  warnings: string[];
}

export interface PaymentSummary {
  id: string;
  receiptNumber: string;
  receivedAt: string;
  branchName: string;
  customerId: string;
  customerName: string;
  method: PaymentMethod;
  amount: number;
  allocatedAmount: number;
  refundedAmount: number;
  unallocatedAmount: number;
  status: 'completed' | 'void';
  receivedByName: string;
  reference: string | null;
}

export interface PaymentDto extends PaymentSummary {
  branchId: string;
  notes: string | null;
  allocations: Array<{ invoiceId: string; invoiceNumber: string; amount: number; reversedAt: string | null }>;
  refunds: Array<{ id: string; refundNumber: string; amount: number; method: PaymentMethod; reason: string; refundedAt: string }>;
  customerBalanceAfter: number;
  organization: { name: string; currency: string; receiptFooter: string | null };
  branch: { name: string; phone: string | null; address: string | null };
}

export interface LedgerRow {
  id: number;
  occurredAt: string;
  entryType: LedgerEntryType;
  reference: string;
  description: string;
  branchName: string;
  debit: number;
  credit: number;
  balance: number;
  sourceType: string;
  sourceId: string;
}

export interface LedgerStatement {
  customer: { id: string; fullName: string; customerCode: string; mobile: string | null; creditLimit: number | null };
  openingBalance: number;
  closingBalance: number;
  totalDebit: number;
  totalCredit: number;
  rows: LedgerRow[];
  scopedToBranches: boolean;
}

export interface OutstandingCustomerRow {
  customerId: string;
  customerCode: string;
  fullName: string;
  mobile: string | null;
  outstanding: number;
  advance: number;
  oldestInvoiceDate: string | null;
  invoiceCount: number;
  creditLimit: number | null;
  buckets: Record<'d0_30' | 'd31_60' | 'd61_90' | 'd90_plus', number>;
  lastReminderAt: string | null;
  lastPaymentAt: string | null;
}

export interface CustomerPackageDto {
  id: string;
  packageId: string;
  packageName: string;
  purchasedAt: string;
  expiresAt: string;
  status: string;
  pricePaid: number;
  items: Array<{ id: string; serviceId: string; serviceName: string; quantityTotal: number; quantityUsed: number; remaining: number }>;
}

// ───────────── Notifications ─────────────
export interface NotificationLogItem {
  id: string;
  createdAt: string;
  eventType: NotificationEventType | string;
  category: NotificationCategory;
  channel: NotificationChannel;
  recipient: string;
  customerId: string | null;
  customerName: string | null;
  status: NotificationStatus;
  statusReason: string | null;
  attempts: number;
  scheduledFor: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  lastError: string | null;
  body: string;
}

// ───────────── Attendance ─────────────
export interface AttendanceDayDto {
  staffId: string;
  staffName: string;
  branchId: string;
  date: string;
  status: AttendanceStatus;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  firstIn: string | null;
  lastOut: string | null;
  workedMinutes: number;
  lateMinutes: number;
  isManualOverride: boolean;
  overrideReason: string | null;
}

// ───────────── Dashboards ─────────────
export interface StatValue {
  value: number;
  previous: number | null;
}

export interface SalonNow {
  timezone: string;
  now: string;
  customersToday: number;
  staffAvailable: number;
  staffServing: number;
  staffOnBreak: number;
  staffAbsent: number;
  staffOnLeave: number;
  waitingCustomers: number;
  upcomingAppointments: number;
  completedToday: number;
  staff: Array<{
    staffId: string;
    displayName: string;
    color: string;
    state: 'available' | 'serving' | 'break' | 'absent' | 'on_leave' | 'off' | 'blocked';
    label: string;
    currentAppointmentId: string | null;
    nextAt: string | null;
  }>;
}

export interface OperationalAlert {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
  link: string | null;
}
