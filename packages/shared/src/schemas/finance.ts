import { z } from 'zod';
import {
  ADJUSTMENT_TYPES,
  ATTENDANCE_STATUSES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_STATUSES,
  PAYMENT_METHODS,
} from '../constants.js';
import {
  optionalDate,
  optionalId,
  optionalText,
  paginationQuery,
  zDate,
  zDateTime,
  zId,
  zMoney,
  zPositiveMoney,
  zQueryList,
} from './common.js';
import { segmentFilterSchema } from './operations.js';

// ───────────── Billing ─────────────
export const invoiceLineSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('service'),
    key: z.string().max(60),
    serviceId: zId,
    staffId: optionalId,
    appointmentItemId: optionalId,
    quantity: z.number().int().min(1).max(99).default(1),
  }),
  z.object({
    type: z.literal('package_redemption'),
    key: z.string().max(60),
    customerPackageItemId: zId,
    staffId: optionalId,
    appointmentItemId: optionalId,
    quantity: z.number().int().min(1).max(99).default(1),
  }),
  z.object({
    type: z.literal('package_sale'),
    key: z.string().max(60),
    packageId: zId,
    staffId: optionalId,
    quantity: z.literal(1).default(1),
  }),
  z.object({
    type: z.literal('custom'),
    key: z.string().max(60),
    description: z.string().trim().min(2).max(200),
    unitPrice: zMoney,
    taxRateBp: z.number().int().min(0).max(10000).nullish(),
    staffId: optionalId,
    quantity: z.number().int().min(1).max(99).default(1),
  }),
]);
export type InvoiceLineInput = z.input<typeof invoiceLineSchema>;

export const paymentPartSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  amount: zPositiveMoney,
  reference: optionalText(100),
});
export type PaymentPartInput = z.input<typeof paymentPartSchema>;

export const manualDiscountSchema = z
  .object({
    type: z.enum(['percentage', 'flat']),
    value: z.number().int().min(1),
    reason: z.string().trim().min(3, 'Give a reason for the discount').max(200),
  })
  .refine((v) => v.type !== 'percentage' || v.value <= 10000, { message: 'Cannot exceed 100%', path: ['value'] });

export const invoiceDraftSchema = z.object({
  branchId: zId,
  customerId: zId,
  appointmentId: optionalId,
  lines: z.array(invoiceLineSchema).min(1, 'Add at least one item').max(50),
  offerId: optionalId,
  offerCode: optionalText(30),
  manualDiscount: manualDiscountSchema.nullish(),
  notes: optionalText(500),
});
export type InvoiceDraftInput = z.input<typeof invoiceDraftSchema>;

export const createInvoiceSchema = invoiceDraftSchema.extend({
  payments: z.array(paymentPartSchema).max(5).default([]),
  /** Apply the customer's advance balance before new payments. */
  useAdvance: z.boolean().default(false),
  dueDate: optionalDate,
  allowCreditLimitOverride: z.boolean().default(false),
  sendReceipt: z.boolean().default(true),
});
export type CreateInvoiceInput = z.input<typeof createInvoiceSchema>;

export const invoiceListQuery = paginationQuery.extend({
  branchId: zId.optional(),
  from: zDate.optional(),
  to: zDate.optional(),
  customerId: zId.optional(),
  paymentStatus: zQueryList(z.enum(['unpaid', 'partial', 'paid', 'void'])),
  staffId: zId.optional(),
});

export const collectPaymentSchema = z.object({
  branchId: zId,
  customerId: zId,
  amount: zPositiveMoney,
  method: z.enum(PAYMENT_METHODS),
  reference: optionalText(100),
  notes: optionalText(500),
  /** Explicit allocation; when omitted the payment settles the oldest pending bills first. */
  allocations: z.array(z.object({ invoiceId: zId, amount: zPositiveMoney })).max(100).optional(),
  sendReceipt: z.boolean().default(true),
});
export type CollectPaymentInput = z.input<typeof collectPaymentSchema>;

export const paymentListQuery = paginationQuery.extend({
  branchId: zId.optional(),
  from: zDate.optional(),
  to: zDate.optional(),
  customerId: zId.optional(),
  method: zQueryList(z.enum(PAYMENT_METHODS)),
  receivedBy: zId.optional(),
});

export const applyAdvanceSchema = z.object({
  invoiceId: zId,
  amount: zPositiveMoney.optional(),
});

export const refundSchema = z.object({
  paymentId: zId,
  amount: zPositiveMoney,
  method: z.enum(PAYMENT_METHODS),
  reference: optionalText(100),
  reason: z.string().trim().min(3).max(300),
});
export type RefundInput = z.input<typeof refundSchema>;

export const adjustmentSchema = z.object({
  invoiceId: zId,
  type: z.enum(ADJUSTMENT_TYPES),
  amount: zPositiveMoney,
  reason: z.string().trim().min(3, 'Give a reason').max(300),
});
export type AdjustmentInput = z.input<typeof adjustmentSchema>;

export const outstandingQuery = paginationQuery.extend({
  branchId: zId.optional(),
  asOf: optionalDate,
  bucket: z.enum(['d0_30', 'd31_60', 'd61_90', 'd90_plus']).optional(),
  minAmount: z.coerce.number().int().min(0).optional(),
});

export const ledgerQuery = z.object({
  customerId: zId,
  branchId: zId.optional(),
  from: zDate.optional(),
  to: zDate.optional(),
});

// ───────────── Notifications ─────────────
export const templateUpdateSchema = z.object({
  subject: optionalText(200),
  body: z.string().trim().min(1).max(4000),
  isActive: z.boolean(),
  providerTemplateName: optionalText(100),
});
export type TemplateUpdateInput = z.input<typeof templateUpdateSchema>;

export const notificationListQuery = paginationQuery.extend({
  status: zQueryList(z.enum(NOTIFICATION_STATUSES)),
  channel: z.enum(NOTIFICATION_CHANNELS).optional(),
  eventType: z.enum(NOTIFICATION_EVENT_TYPES).optional(),
  customerId: zId.optional(),
  from: zDate.optional(),
  to: zDate.optional(),
});

export const campaignSchema = z.object({
  name: z.string().trim().min(2).max(120),
  eventType: z.enum(['offer', 're_engagement', 'birthday']).default('offer'),
  channel: z.enum(NOTIFICATION_CHANNELS),
  segmentFilter: segmentFilterSchema,
  subject: optionalText(200),
  body: z.string().trim().min(5).max(2000),
  scheduledAt: zDateTime.nullish(),
});
export type CampaignInput = z.input<typeof campaignSchema>;

// ───────────── Attendance ─────────────
export const manualPunchSchema = z.object({
  staffId: zId,
  punchedAt: zDateTime,
  direction: z.enum(['in', 'out']),
  reason: z.string().trim().min(3).max(200),
});
export type ManualPunchInput = z.input<typeof manualPunchSchema>;

export const attendanceOverrideSchema = z.object({
  staffId: zId,
  date: zDate,
  status: z.enum(ATTENDANCE_STATUSES),
  reason: z.string().trim().min(3).max(200),
});
export type AttendanceOverrideInput = z.input<typeof attendanceOverrideSchema>;

export const attendanceQuery = z.object({
  branchId: zId.optional(),
  date: zDate.optional(),
  from: zDate.optional(),
  to: zDate.optional(),
  staffId: zId.optional(),
});

/** Payload accepted from biometric devices that push punches (signed webhook). */
export const biometricPushSchema = z.object({
  punches: z
    .array(
      z.object({
        externalId: z.string().min(1).max(120),
        punchId: z.string().min(1).max(40),
        punchedAt: zDateTime,
        direction: z.enum(['in', 'out', 'unknown']).default('unknown'),
      }),
    )
    .min(1)
    .max(1000),
});

// ───────────── Reports ─────────────
export const reportQuery = z.object({
  from: zDate,
  to: zDate,
  branchId: zId.optional(),
  staffId: zId.optional(),
  serviceId: zId.optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  receivedBy: zId.optional(),
  customerId: zId.optional(),
  groupBy: z.enum(['day', 'week', 'month']).default('day'),
  /** For the inactive-customers report: no visit for at least this many days. */
  inactiveDays: z.coerce.number().int().min(1).max(3650).default(60),
  /** Collection summary: all payments, only settlements of earlier credit, or only advances. */
  collectionType: z.enum(['all', 'sale', 'credit_settlement', 'advance']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  format: z.enum(['json', 'csv']).default('json'),
});
export type ReportQuery = z.output<typeof reportQuery>;

export const dashboardQuery = z.object({
  branchId: zId.optional(),
  from: zDate,
  to: zDate,
});
export type DashboardQuery = z.output<typeof dashboardQuery>;

export const auditQuery = paginationQuery.extend({
  entityType: z.string().trim().max(40).optional(),
  entityId: z.string().trim().max(60).optional(),
  userId: zId.optional(),
  action: z.string().trim().max(60).optional(),
  from: zDate.optional(),
  to: zDate.optional(),
});

export const datetimeSchema = zDateTime;
export const optionalReason = optionalText(300);
