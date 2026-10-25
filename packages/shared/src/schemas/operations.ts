import { z } from 'zod';
import {
  APPOINTMENT_SOURCES,
  APPOINTMENT_STATUSES,
  CUSTOMER_SOURCES,
  GENDERS,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
} from '../constants.js';
import {
  optionalDate,
  optionalEmail,
  optionalId,
  optionalPhone,
  optionalText,
  paginationQuery,
  zDate,
  zDateTime,
  zId,
  zMoney,
  zName,
  zQueryBoolean,
  zQueryList,
} from './common.js';

// ───────────── Customers ─────────────
export const preferenceSchema = z.object({
  channel: z.enum(NOTIFICATION_CHANNELS),
  category: z.enum(NOTIFICATION_CATEGORIES),
  enabled: z.boolean(),
});

export const customerSchema = z.object({
  fullName: zName,
  mobile: optionalPhone,
  whatsappNumber: optionalPhone,
  email: optionalEmail,
  gender: z.enum(GENDERS).default('unspecified'),
  dateOfBirth: optionalDate,
  anniversaryDate: optionalDate,
  address: optionalText(500),
  city: optionalText(80),
  preferredBranchId: optionalId,
  preferredStaffId: optionalId,
  source: z.enum(CUSTOMER_SOURCES).default('walk_in'),
  referredById: optionalId,
  notes: optionalText(2000),
  tags: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
  creditLimit: zMoney.nullish(),
  marketingConsent: z.boolean().default(false),
  preferences: z.array(preferenceSchema).max(15).optional(),
});
export type CustomerInput = z.input<typeof customerSchema>;

export const customerUpdateSchema = customerSchema.partial().extend({
  status: z.enum(['active', 'inactive', 'archived']).optional(),
});
export type CustomerUpdateInput = z.input<typeof customerUpdateSchema>;

/** Minimal "Add customer" used inline from booking, walk-in and billing (requirement 86.2). */
export const quickCustomerSchema = z.object({
  fullName: zName,
  mobile: optionalPhone,
  gender: z.enum(GENDERS).default('unspecified'),
  email: optionalEmail,
  marketingConsent: z.boolean().default(false),
});
export type QuickCustomerInput = z.input<typeof quickCustomerSchema>;

export const customerListQuery = paginationQuery.extend({
  status: z.enum(['active', 'inactive', 'archived', 'all']).default('active'),
  tag: z.string().trim().max(30).optional(),
  hasOutstanding: zQueryBoolean.optional(),
  branchId: zId.optional(),
});

export const customerPreferencesSchema = z.object({
  marketingConsent: z.boolean().optional(),
  preferences: z.array(preferenceSchema).max(15),
  source: z.enum(['in_person', 'phone', 'online_form', 'customer_request']).default('in_person'),
});
export type CustomerPreferencesInput = z.input<typeof customerPreferencesSchema>;

export const segmentFilterSchema = z.object({
  branchId: optionalId,
  minLifetimeSpend: zMoney.nullish(),
  maxLifetimeSpend: zMoney.nullish(),
  minVisits: z.number().int().min(0).nullish(),
  maxVisits: z.number().int().min(0).nullish(),
  inactiveForDays: z.number().int().min(1).max(3650).nullish(),
  visitedWithinDays: z.number().int().min(1).max(3650).nullish(),
  favoriteServiceId: optionalId,
  favoriteStaffId: optionalId,
  minOutstanding: zMoney.nullish(),
  gender: z.enum(GENDERS).nullish(),
  birthdayMonth: z.number().int().min(1).max(12).nullish(),
  tag: optionalText(30),
  marketingConsentOnly: z.boolean().default(false),
});
export type SegmentFilter = z.output<typeof segmentFilterSchema>;
export type SegmentFilterInput = z.input<typeof segmentFilterSchema>;

export const segmentSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: optionalText(300),
  filter: segmentFilterSchema,
});
export type SegmentInput = z.input<typeof segmentSchema>;

// ───────────── Scheduling / availability ─────────────
export const availabilityQuery = z.object({
  branchId: zId,
  date: zDate,
  serviceIds: zQueryList(zId).refine((v) => v.length > 0, 'Choose at least one service'),
  staffId: zId.optional(),
  customerId: zId.optional(),
  excludeAppointmentId: zId.optional(),
  allowOutsideHours: zQueryBoolean.optional(),
  /** Desired start for "who is free at this time?" (ISO). Without it the API returns the day's slots per staff. */
  startAt: zDateTime.optional(),
});
export type AvailabilityQuery = z.output<typeof availabilityQuery>;

// ───────────── Appointments ─────────────
export const appointmentItemInput = z.object({
  serviceId: zId,
  staffId: zId,
  /** Required for the first service; later services default to starting right after the previous one. */
  startAt: zDateTime.optional(),
  durationMinutes: z.number().int().min(5).max(720).optional(),
  customerPackageItemId: optionalId,
});
export type AppointmentItemInput = z.input<typeof appointmentItemInput>;

export const createAppointmentSchema = z.object({
  branchId: zId,
  customerId: zId,
  source: z.enum(APPOINTMENT_SOURCES).default('phone'),
  status: z.enum(['scheduled', 'confirmed']).default('scheduled'),
  notes: optionalText(1000),
  internalNotes: optionalText(1000),
  items: z.array(appointmentItemInput).min(1, 'Add at least one service').max(10),
  notifyCustomer: z.boolean().default(true),
  allowOutsideHours: z.boolean().default(false),
});
export type CreateAppointmentInput = z.input<typeof createAppointmentSchema>;

export const updateAppointmentSchema = z.object({
  version: z.number().int().min(1),
  customerId: zId.optional(),
  notes: optionalText(1000).optional(),
  internalNotes: optionalText(1000).optional(),
  items: z.array(appointmentItemInput).min(1).max(10).optional(),
  notifyCustomer: z.boolean().default(true),
  allowOutsideHours: z.boolean().default(false),
});
export type UpdateAppointmentInput = z.input<typeof updateAppointmentSchema>;

/** Calendar drag & drop: move the whole booking (all services shift together) and optionally reassign one line. */
export const moveAppointmentSchema = z.object({
  version: z.number().int().min(1),
  itemId: zId,
  startAt: zDateTime,
  staffId: zId.optional(),
  /** Resize (end-drag) for the dragged line only. */
  durationMinutes: z.number().int().min(5).max(720).optional(),
  notifyCustomer: z.boolean().default(true),
  allowOutsideHours: z.boolean().default(false),
});
export type MoveAppointmentInput = z.input<typeof moveAppointmentSchema>;

export const appointmentStatusSchema = z.object({
  status: z.enum(APPOINTMENT_STATUSES),
  version: z.number().int().min(1).optional(),
  reason: optionalText(500),
  notifyCustomer: z.boolean().default(true),
});
export type AppointmentStatusInput = z.input<typeof appointmentStatusSchema>;

export const appointmentListQuery = paginationQuery.extend({
  branchId: zId.optional(),
  from: zDate.optional(),
  to: zDate.optional(),
  status: zQueryList(z.enum(APPOINTMENT_STATUSES)),
  source: z.enum(APPOINTMENT_SOURCES).optional(),
  staffId: zId.optional(),
  customerId: zId.optional(),
  serviceId: zId.optional(),
});

export const calendarQuery = z.object({
  branchId: zId,
  from: zDate,
  to: zDate,
  staffIds: zQueryList(zId),
});

// ───────────── Walk-ins ─────────────
export const createWalkInSchema = z
  .object({
    branchId: zId,
    customerId: optionalId,
    newCustomer: z
      .object({ fullName: zName, mobile: optionalPhone, gender: z.enum(GENDERS).default('unspecified') })
      .optional(),
    items: z
      .array(z.object({ serviceId: zId, staffId: optionalId }))
      .min(1, 'Choose at least one service')
      .max(10),
    notes: optionalText(1000),
    startNow: z.boolean().default(false),
  })
  .refine((v) => v.customerId || v.newCustomer, { message: 'Choose or add a customer', path: ['customerId'] });
export type CreateWalkInInput = z.input<typeof createWalkInSchema>;

export const assignWalkInSchema = z.object({
  version: z.number().int().min(1),
  assignments: z.array(z.object({ itemId: zId, staffId: zId })).min(1),
  startNow: z.boolean().default(false),
});
export type AssignWalkInInput = z.input<typeof assignWalkInSchema>;

// ───────────── Public booking ─────────────
export const publicBookingSchema = z.object({
  branchId: zId,
  serviceIds: z.array(zId).min(1).max(5),
  staffId: optionalId,
  startAt: zDateTime,
  customer: z.object({
    fullName: zName,
    mobile: z.string().trim().min(6).max(20),
    email: optionalEmail,
    marketingConsent: z.boolean().default(false),
  }),
  notes: optionalText(500),
  /** Honeypot field: real users never fill it. */
  website: z.string().max(0).optional(),
});
export type PublicBookingInput = z.input<typeof publicBookingSchema>;
