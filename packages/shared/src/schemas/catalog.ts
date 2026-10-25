import { z } from 'zod';
import {
  COMMISSION_TYPES,
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_TYPES,
  GENDERS,
  HALF_DAY_OPTIONS,
  LEAVE_STATUSES,
  LEAVE_TYPES,
  OFFER_DISCOUNT_TYPES,
  OFFER_ELIGIBILITY,
  OFFER_SCOPES,
  PACKAGE_SEGMENTS,
  SERVICE_GENDERS,
} from '../constants.js';
import {
  optionalDate,
  optionalEmail,
  optionalPhone,
  optionalText,
  zBasisPoints,
  zCode,
  zColor,
  zDate,
  zDateTime,
  zId,
  zMoney,
  zName,
  zTime,
  zWeekday,
} from './common.js';

// ───────────── Expertise & categories ─────────────
export const expertiseSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: optionalText(300),
});
export type ExpertiseInput = z.input<typeof expertiseSchema>;

export const categorySchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: optionalText(300),
  color: zColor.default('#8b5cf6'),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});
export type CategoryInput = z.input<typeof categorySchema>;

// ───────────── Services ─────────────
export const serviceSchema = z
  .object({
    categoryId: zId,
    code: zCode,
    name: zName,
    description: optionalText(1000),
    durationMinutes: z.number().int().min(5, 'At least 5 minutes').max(720),
    bufferMinutes: z.number().int().min(0).max(120).default(0),
    price: zMoney,
    taxRateBp: zBasisPoints.nullish(),
    gender: z.enum(SERVICE_GENDERS).default('unisex'),
    allBranches: z.boolean().default(true),
    branches: z
      .array(z.object({ branchId: zId, priceOverride: zMoney.nullish() }))
      .default([]),
    expertiseIds: z.array(zId).default([]),
    onlineBookable: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(9999).default(0),
    status: z.enum(['active', 'inactive', 'archived']).default('active'),
  })
  .refine((v) => v.allBranches || v.branches.length > 0, {
    message: 'Choose at least one branch',
    path: ['branches'],
  });
export type ServiceInput = z.input<typeof serviceSchema>;

// ───────────── Staff ─────────────
export const staffSchema = z.object({
  branchId: zId,
  employeeCode: zCode,
  fullName: zName,
  displayName: z.string().trim().min(1).max(40),
  gender: z.enum(GENDERS).default('unspecified'),
  dateOfBirth: optionalDate,
  mobile: optionalPhone,
  email: optionalEmail,
  address: optionalText(500),
  joiningDate: optionalDate,
  exitDate: optionalDate,
  designation: optionalText(80),
  employmentType: z.enum(EMPLOYMENT_TYPES).default('full_time'),
  employmentStatus: z.enum(EMPLOYMENT_STATUSES).default('active'),
  biometricPunchId: optionalText(40),
  photoUrl: z.union([z.url(), z.literal('')]).nullish().transform((v) => (v ? v : null)),
  calendarColor: zColor.default('#6366f1'),
  calendarOrder: z.number().int().min(0).max(9999).default(0),
  isBookable: z.boolean().default(true),
  onlineBookable: z.boolean().default(true),
  commissionType: z.enum(COMMISSION_TYPES).default('none'),
  commissionValue: z.number().int().min(0).max(1_000_000_000).default(0),
  notes: optionalText(2000),
  expertiseIds: z.array(zId).default([]),
});
export type StaffInput = z.input<typeof staffSchema>;

export const staffServicesSchema = z.object({
  services: z
    .array(
      z.object({
        serviceId: zId,
        durationMinutes: z.number().int().min(5).max(720).nullish(),
        priceOverride: zMoney.nullish(),
        commissionType: z.enum(COMMISSION_TYPES).nullish(),
        commissionValue: z.number().int().min(0).nullish(),
        isActive: z.boolean().default(true),
      }),
    )
    .max(500),
});
export type StaffServicesInput = z.input<typeof staffServicesSchema>;

const timeWindow = z
  .object({ weekday: zWeekday, startTime: zTime, endTime: zTime })
  .refine((w) => w.startTime < w.endTime, { message: 'Start must be before end', path: ['endTime'] });

export const staffWeeklyScheduleSchema = z.object({
  shifts: z.array(timeWindow).max(28),
  breaks: z.array(timeWindow.and(z.object({ label: z.string().trim().min(1).max(40).default('Break') }))).max(28),
});
export type StaffWeeklyScheduleInput = z.input<typeof staffWeeklyScheduleSchema>;

export const scheduleOverrideSchema = z
  .object({
    date: zDate,
    isWorking: z.boolean(),
    startTime: zTime.nullish(),
    endTime: zTime.nullish(),
    reason: optionalText(200),
  })
  .refine((v) => !v.isWorking || (v.startTime && v.endTime && v.startTime < v.endTime), {
    message: 'Give working hours for this day',
    path: ['endTime'],
  });
export type ScheduleOverrideInput = z.input<typeof scheduleOverrideSchema>;

export const leaveSchema = z
  .object({
    staffId: zId,
    leaveType: z.enum(LEAVE_TYPES).default('casual'),
    startDate: zDate,
    endDate: zDate,
    halfDay: z.enum(HALF_DAY_OPTIONS).default('none'),
    reason: optionalText(500),
    status: z.enum(LEAVE_STATUSES).default('approved'),
  })
  .refine((v) => v.endDate >= v.startDate, { message: 'End date must be on or after start date', path: ['endDate'] })
  .refine((v) => v.halfDay === 'none' || v.startDate === v.endDate, {
    message: 'Half-day leave must be a single day',
    path: ['halfDay'],
  });
export type LeaveInput = z.input<typeof leaveSchema>;

export const leaveDecisionSchema = z.object({ status: z.enum(['approved', 'rejected', 'cancelled']) });

export const timeBlockSchema = z
  .object({
    staffId: zId,
    startAt: zDateTime,
    endAt: zDateTime,
    reason: z.string().trim().min(2).max(200),
  })
  .refine((v) => new Date(v.endAt) > new Date(v.startAt), { message: 'End must be after start', path: ['endAt'] });
export type TimeBlockInput = z.input<typeof timeBlockSchema>;

// ───────────── Offers ─────────────
export const offerSchema = z
  .object({
    name: zName,
    description: optionalText(500),
    code: z
      .union([z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,30}$/, 'Use 3–30 letters, numbers or dashes'), z.literal('')])
      .nullish()
      .transform((v) => (v ? v : null)),
    discountType: z.enum(OFFER_DISCOUNT_TYPES),
    discountValue: z.number().int().min(1),
    maxDiscountAmount: zMoney.nullish(),
    minBillAmount: zMoney.nullish(),
    appliesTo: z.enum(OFFER_SCOPES).default('all_services'),
    serviceIds: z.array(zId).default([]),
    categoryIds: z.array(zId).default([]),
    eligibility: z.enum(OFFER_ELIGIBILITY).default('all'),
    loyaltyMinVisits: z.number().int().min(1).nullish(),
    loyaltyMinSpend: zMoney.nullish(),
    birthdayWindowDays: z.number().int().min(0).max(31).default(7),
    customerIds: z.array(zId).default([]),
    validFrom: zDate,
    validTo: zDate,
    validWeekdays: z.array(zWeekday).max(7).nullish(),
    allBranches: z.boolean().default(true),
    branchIds: z.array(zId).default([]),
    autoApply: z.boolean().default(false),
    usageLimitTotal: z.number().int().min(1).nullish(),
    usageLimitPerCustomer: z.number().int().min(1).nullish(),
    status: z.enum(['active', 'inactive', 'archived']).default('active'),
  })
  .refine((v) => v.validTo >= v.validFrom, { message: 'End date must be on or after start date', path: ['validTo'] })
  .refine((v) => v.discountType !== 'percentage' || v.discountValue <= 10000, {
    message: 'Percentage cannot exceed 100%',
    path: ['discountValue'],
  })
  .refine((v) => !['services', 'combo'].includes(v.appliesTo) || v.serviceIds.length > (v.appliesTo === 'combo' ? 1 : 0), {
    message: 'Choose the services this offer applies to (a combo needs at least two)',
    path: ['serviceIds'],
  })
  .refine((v) => v.appliesTo !== 'categories' || v.categoryIds.length > 0, {
    message: 'Choose at least one category',
    path: ['categoryIds'],
  })
  .refine((v) => v.eligibility !== 'loyalty' || v.loyaltyMinVisits || v.loyaltyMinSpend, {
    message: 'Set minimum visits or minimum spend for loyal customers',
    path: ['loyaltyMinVisits'],
  })
  .refine((v) => v.eligibility !== 'specific_customers' || v.customerIds.length > 0, {
    message: 'Choose at least one customer',
    path: ['customerIds'],
  })
  .refine((v) => v.allBranches || v.branchIds.length > 0, { message: 'Choose at least one branch', path: ['branchIds'] });
export type OfferInput = z.input<typeof offerSchema>;

// ───────────── Packages ─────────────
export const packageSchema = z
  .object({
    code: zCode,
    name: zName,
    description: optionalText(1000),
    price: zMoney,
    taxRateBp: zBasisPoints.nullish(),
    validityDays: z.number().int().min(1).max(1095),
    items: z
      .array(z.object({ serviceId: zId, quantity: z.number().int().min(1).max(100) }))
      .min(1, 'Add at least one service'),
    allBranches: z.boolean().default(true),
    branchIds: z.array(zId).default([]),
    customerSegment: z.enum(PACKAGE_SEGMENTS).default('all'),
    maxPerCustomer: z.number().int().min(1).nullish(),
    saleLimitTotal: z.number().int().min(1).nullish(),
    saleStartsOn: optionalDate,
    saleEndsOn: optionalDate,
    status: z.enum(['active', 'inactive', 'archived']).default('active'),
  })
  .refine((v) => new Set(v.items.map((i) => i.serviceId)).size === v.items.length, {
    message: 'Each service can appear only once — increase its quantity instead',
    path: ['items'],
  })
  .refine((v) => v.allBranches || v.branchIds.length > 0, { message: 'Choose at least one branch', path: ['branchIds'] });
export type PackageInput = z.input<typeof packageSchema>;
