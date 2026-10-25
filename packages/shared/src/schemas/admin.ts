import { z } from 'zod';
import { HOME_SCREENS, INTEGRATION_KINDS, TWO_FACTOR_REQUIREMENTS } from '../constants.js';
import { ALL_PERMISSIONS } from '../permissions.js';
import {
  optionalEmail,
  optionalId,
  optionalPhone,
  optionalText,
  passwordSchema,
  zColor,
  zEmail,
  zId,
  zMoney,
  zName,
  zDate,
  zTime,
  zWeekday,
  zBasisPoints,
} from './common.js';

// ───────────── Auth ─────────────
export const loginSchema = z.object({
  identifier: z.string().trim().min(3, 'Enter your email or mobile number').max(200),
  password: z.string().min(1, 'Enter your password').max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** A six-digit authenticator code, or a recovery code such as ABCDE-FGH23 (dashes and case are ignored). */
export const twoFactorCodeSchema = z
  .string()
  .trim()
  .min(6, 'Enter the 6-digit code from your authenticator app')
  .max(20)
  .regex(/^[A-Za-z0-9 -]+$/, 'Enter the code exactly as shown');

export const mfaLoginSchema = z.object({
  mfaToken: z.string().min(20).max(2000),
  code: twoFactorCodeSchema,
});
export const mfaEnableSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app') });
export const mfaConfirmSchema = z.object({
  password: z.string().min(1, 'Enter your password').max(200),
  code: twoFactorCodeSchema,
});
export type MfaConfirmInput = z.infer<typeof mfaConfirmSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: passwordSchema,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: 'Choose a password different from the current one',
    path: ['newPassword'],
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

// ───────────── Organizations (platform) ─────────────
export const timezoneSchema = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Unknown time zone' },
);

export const orgCodeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'Use 2–40 lowercase letters, numbers or dashes');

export const branchCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,10}$/, 'Use 2–10 letters or numbers');

export const createOrganizationSchema = z.object({
  name: zName,
  code: orgCodeSchema,
  legalName: optionalText(200),
  contactPerson: optionalText(120),
  email: optionalEmail,
  phone: optionalPhone,
  country: z.string().length(2).toUpperCase().default('IN'),
  currency: z.string().length(3).toUpperCase().default('INR'),
  timezone: timezoneSchema.default('Asia/Kolkata'),
  taxId: optionalText(40),
  subscriptionPlan: z.enum(['trial', 'starter', 'growth', 'enterprise']).default('trial'),
  maxBranches: z.number().int().min(1).max(1000).nullish(),
  owner: z.object({
    fullName: zName,
    email: zEmail,
    phone: optionalPhone,
    password: passwordSchema,
  }),
  firstBranch: z.object({
    name: zName,
    code: branchCodeSchema,
    city: optionalText(80),
  }),
});
export type CreateOrganizationInput = z.input<typeof createOrganizationSchema>;

export const updateOrganizationStatusSchema = z.object({
  status: z.enum(['active', 'suspended', 'archived']).optional(),
  subscriptionPlan: z.enum(['trial', 'starter', 'growth', 'enterprise']).optional(),
  subscriptionStatus: z.enum(['trialing', 'active', 'past_due', 'cancelled']).optional(),
  maxBranches: z.number().int().min(1).max(1000).nullish(),
});

export const organizationProfileSchema = z.object({
  name: zName,
  legalName: optionalText(200),
  contactPerson: optionalText(120),
  email: optionalEmail,
  phone: optionalPhone,
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(80),
  state: optionalText(80),
  postalCode: optionalText(20),
  taxId: optionalText(40),
  taxLabel: z.string().trim().min(1).max(20).default('GST'),
  timezone: timezoneSchema,
  logoUrl: z.union([z.url(), z.literal('')]).nullish().transform((v) => (v ? v : null)),
});
export type OrganizationProfileInput = z.input<typeof organizationProfileSchema>;

export const organizationSettingsSchema = z
  .object({
    slotIntervalMinutes: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20), z.literal(30), z.literal(60)]),
    defaultBufferMinutes: z.number().int().min(0).max(120),
    allowOutsideHours: z.boolean(),
    minBookingNoticeMinutes: z.number().int().min(0).max(10080),
    maxAdvanceBookingDays: z.number().int().min(1).max(730),
    reminderOffsetsMinutes: z.array(z.number().int().min(15).max(10080)).max(4),
    quietHoursStart: zTime,
    quietHoursEnd: zTime,
    pricesIncludeTax: z.boolean(),
    defaultTaxRateBp: zBasisPoints,
    roundOffToMinor: z.union([z.literal(1), z.literal(5), z.literal(10), z.literal(50), z.literal(100)]),
    creditDueDays: z.number().int().min(0).max(365),
    outstandingReminderEnabled: z.boolean(),
    outstandingReminderMinAmount: zMoney,
    outstandingReminderIntervalDays: z.number().int().min(1).max(90),
    outstandingReminderMaxPerMonth: z.number().int().min(1).max(31),
    staffCanViewCustomerPhone: z.boolean(),
    staffCanViewOwnPerformance: z.boolean(),
    onlineBookingEnabled: z.boolean(),
    twoFactorRequirement: z.enum(TWO_FACTOR_REQUIREMENTS),
    invoicePrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,6}$/),
    receiptPrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,6}$/),
    bookingPrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,6}$/),
    receiptFooter: optionalText(500),
  })
  .partial();
export type OrganizationSettingsInput = z.input<typeof organizationSettingsSchema>;

// ───────────── Branches ─────────────
export const branchSchema = z.object({
  name: zName,
  code: branchCodeSchema,
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(80),
  state: optionalText(80),
  postalCode: optionalText(20),
  phone: optionalPhone,
  email: optionalEmail,
  timezone: timezoneSchema,
  managerUserId: optionalId,
  status: z.enum(['active', 'inactive', 'archived']).default('active'),
});
export type BranchInput = z.input<typeof branchSchema>;

export const branchHoursSchema = z.object({
  hours: z
    .array(
      z
        .object({
          weekday: zWeekday,
          isClosed: z.boolean(),
          openTime: zTime.nullish(),
          closeTime: zTime.nullish(),
        })
        .refine((h) => h.isClosed || (h.openTime && h.closeTime && h.openTime < h.closeTime), {
          message: 'Opening time must be before closing time',
          path: ['closeTime'],
        }),
    )
    .length(7, 'Provide all seven days'),
});
export type BranchHoursInput = z.input<typeof branchHoursSchema>;

export const holidaySchema = z.object({
  date: zDate,
  name: z.string().trim().min(2).max(80),
  branchId: optionalId,
});
export type HolidayInput = z.input<typeof holidaySchema>;

// ───────────── Users & roles ─────────────
export const createUserSchema = z
  .object({
    fullName: zName,
    email: optionalEmail,
    phone: optionalPhone,
    roleId: zId,
    allBranches: z.boolean().default(false),
    branchIds: z.array(zId).default([]),
    password: passwordSchema,
    staffId: optionalId,
  })
  .refine((v) => v.email || v.phone, { message: 'Give an email or a mobile number to log in with', path: ['email'] })
  .refine((v) => v.allBranches || v.branchIds.length > 0, { message: 'Choose at least one branch', path: ['branchIds'] });
export type CreateUserInput = z.input<typeof createUserSchema>;

export const updateUserSchema = z.object({
  fullName: zName.optional(),
  email: optionalEmail.optional(),
  phone: optionalPhone.optional(),
  roleId: zId.optional(),
  allBranches: z.boolean().optional(),
  branchIds: z.array(zId).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  staffId: optionalId.optional(),
});
export type UpdateUserInput = z.input<typeof updateUserSchema>;

export const resetPasswordSchema = z.object({ password: passwordSchema });

export const roleSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: optionalText(300),
  homeScreen: z.enum(HOME_SCREENS),
  permissions: z.array(z.enum(ALL_PERMISSIONS as [string, ...string[]])).max(200),
});
export type RoleInput = z.input<typeof roleSchema>;

// ───────────── Integrations ─────────────
export const integrationSchema = z.object({
  kind: z.enum(INTEGRATION_KINDS),
  provider: z.string().trim().min(2).max(40),
  displayName: z.string().trim().min(2).max(80),
  branchId: optionalId,
  config: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean()])).default({}),
  /** Write-only. Stored encrypted; never returned by the API. */
  secrets: z.record(z.string(), z.string().max(2000)).optional(),
  status: z.enum(['active', 'inactive']).default('active'),
});
export type IntegrationInput = z.input<typeof integrationSchema>;

// ───────────── Onboarding ─────────────
export const ONBOARDING_STEPS = [
  'salon',
  'branches',
  'services',
  'staff',
  'expertise',
  'hours',
  'messaging',
  'ready',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export const ONBOARDING_STEP_LABELS: Record<OnboardingStep, string> = {
  salon: 'Salon information',
  branches: 'Branches',
  services: 'Services',
  staff: 'Staff',
  expertise: 'Staff expertise',
  hours: 'Business hours',
  messaging: 'WhatsApp & email',
  ready: 'Ready to use',
};

export const onboardingStepSchema = z.object({
  step: z.enum(ONBOARDING_STEPS),
  status: z.enum(['done', 'skipped']),
});

export const quickColorSchema = zColor;
