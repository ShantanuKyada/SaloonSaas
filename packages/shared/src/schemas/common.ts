import { z } from 'zod';
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '../constants.js';

export const zId = z.uuid({ error: 'Invalid reference' });
/** Money in minor units; capped at 10 crore rupees per amount to catch typos. */
export const zMoney = z.number().int('Amount must be a whole number of paise').min(0).max(1_000_000_000);
export const zPositiveMoney = zMoney.min(1, 'Amount must be greater than zero');
export const zBasisPoints = z.number().int().min(0).max(10000);
export const zDate = z.iso.date({ error: 'Use a valid date' });
export const zDateTime = z.iso.datetime({ offset: true, error: 'Use a valid date and time' });
export const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
export const zWeekday = z.number().int().min(1).max(7);
export const zColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #6366F1');
export const zName = z.string().trim().min(1, 'Required').max(120);
export const zCode = z
  .string()
  .trim()
  .min(2)
  .max(20)
  .regex(/^[A-Za-z0-9-]+$/, 'Use letters, numbers and dashes only');
export const zEmail = z.email({ error: 'Enter a valid email address' }).max(200);
/** Raw phone input; the API normalises to E.164 with the organisation's country code. */
export const zPhoneInput = z.string().trim().min(6, 'Enter a valid mobile number').max(20);

/** Optional free text: empty strings become null so the API stores "no value" consistently. */
export const optionalText = (max = 500) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

export const optionalEmail = z
  .union([zEmail, z.literal('')])
  .nullish()
  .transform((v) => (v ? v : null));

export const optionalPhone = z
  .union([zPhoneInput, z.literal('')])
  .nullish()
  .transform((v) => (v ? v : null));

export const optionalDate = z
  .union([zDate, z.literal('')])
  .nullish()
  .transform((v) => (v ? v : null));

export const optionalId = z
  .union([zId, z.literal('')])
  .nullish()
  .transform((v) => (v ? v : null));

const booleanish = z.union([z.boolean(), z.enum(['true', 'false'])]).transform((v) => v === true || v === 'true');
export const zQueryBoolean = booleanish;

/** Comma-separated or repeated query parameter → string[]. */
export const zQueryList = <T extends z.ZodType>(item: T) =>
  z.preprocess(
    (v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : String(v).split(',').filter(Boolean)),
    z.array(item),
  );

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
  search: z.string().trim().max(100).optional(),
  sortBy: z.string().trim().max(40).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuery>;

export const dateRangeQuery = z
  .object({
    from: zDate,
    to: zDate,
  })
  .refine((v) => v.from <= v.to, { message: '"From" must be on or before "To"', path: ['to'] });

export const branchScopedQuery = z.object({
  branchId: zId.optional(),
});

export const reasonSchema = z.object({
  reason: z.string().trim().min(3, 'Please give a short reason').max(500),
});
export type ReasonInput = z.infer<typeof reasonSchema>;

export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200)
  .regex(/[A-Za-z]/, 'Include at least one letter')
  .regex(/\d/, 'Include at least one number');
