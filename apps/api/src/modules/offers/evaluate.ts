import { calculateInvoice, formatMoney, type DiscountRule } from '@salon/shared';
import { DateTime } from 'luxon';
import { isoWeekday } from '../../core/time.js';
import type { Tx } from '../../db/tenant.js';

// Decides whether an offer may be used on a bill. Pure rules + the minimum reads they need; the same function is
// used for the live preview, the offer picker and the authoritative check when the bill is created.

export interface OfferLine {
  key: string;
  itemType: string;
  serviceId: string | null;
  categoryId: string | null;
  gross: number;
}

export interface OfferContext {
  orgId: string;
  branchId: string;
  /** Branch-local date (YYYY-MM-DD) of the bill. */
  today: string;
  currency: string;
  customerId: string;
  lines: OfferLine[];
}

type OfferRow = Awaited<ReturnType<typeof loadOffers>>[number];

export type OfferResult =
  | { ok: true; offer: OfferRow; rule: DiscountRule; eligibleKeys: string[]; estimated: number }
  | { ok: false; offer: OfferRow; reason: string };

export async function loadOffers(tx: Tx, orgId: string, filter: { id?: string; code?: string } = {}) {
  let q = tx.selectFrom('offers').selectAll().where('organizationId', '=', orgId).where('status', '=', 'active');
  if (filter.id) q = q.where('id', '=', filter.id);
  if (filter.code) q = q.where('code', '=', filter.code.toUpperCase());
  return q.execute();
}

interface Relations {
  services: Set<string>;
  categories: Set<string>;
  branches: Set<string>;
  customers: Set<string>;
}

async function loadRelations(tx: Tx, offerIds: string[]): Promise<Map<string, Relations>> {
  const map = new Map<string, Relations>(offerIds.map((id) => [id, { services: new Set(), categories: new Set(), branches: new Set(), customers: new Set() }]));
  if (!offerIds.length) return map;
  const [s, c, b, cu] = await Promise.all([
    tx.selectFrom('offerServices').select(['offerId', 'serviceId']).where('offerId', 'in', offerIds).execute(),
    tx.selectFrom('offerCategories').select(['offerId', 'categoryId']).where('offerId', 'in', offerIds).execute(),
    tx.selectFrom('offerBranches').select(['offerId', 'branchId']).where('offerId', 'in', offerIds).execute(),
    tx.selectFrom('offerCustomers').select(['offerId', 'customerId']).where('offerId', 'in', offerIds).execute(),
  ]);
  for (const r of s) map.get(r.offerId)!.services.add(r.serviceId);
  for (const r of c) map.get(r.offerId)!.categories.add(r.categoryId);
  for (const r of b) map.get(r.offerId)!.branches.add(r.branchId);
  for (const r of cu) map.get(r.offerId)!.customers.add(r.customerId);
  return map;
}

function birthdayWithin(dob: string, today: string, windowDays: number): boolean {
  const t = DateTime.fromISO(today);
  const d = DateTime.fromISO(dob);
  for (const year of [t.year - 1, t.year, t.year + 1]) {
    const day = d.month === 2 && d.day === 29 && !DateTime.local(year).isInLeapYear ? 28 : d.day;
    const candidate = DateTime.fromObject({ year, month: d.month, day });
    if (Math.abs(candidate.diff(t, 'days').days) <= windowDays) return true;
  }
  return false;
}

export async function evaluateOffers(tx: Tx, ctx: OfferContext, offers: OfferRow[]): Promise<OfferResult[]> {
  if (!offers.length) return [];
  const relations = await loadRelations(tx, offers.map((o) => o.id));
  const customer = await tx
    .selectFrom('customers as c')
    .leftJoin('customerStats as cs', 'cs.customerId', 'c.id')
    .select(['c.dateOfBirth', 'cs.visitCount', 'cs.lifetimeSpend'])
    .where('c.organizationId', '=', ctx.orgId)
    .where('c.id', '=', ctx.customerId)
    .executeTakeFirstOrThrow();
  const priorInvoices = await tx
    .selectFrom('invoices')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('organizationId', '=', ctx.orgId)
    .where('customerId', '=', ctx.customerId)
    .where('status', '=', 'issued')
    .executeTakeFirstOrThrow();
  const usage = await tx
    .selectFrom('offerRedemptions')
    .select(['offerId', (eb) => eb.fn.countAll<number>().as('n')])
    .where('organizationId', '=', ctx.orgId)
    .where('customerId', '=', ctx.customerId)
    .where('reversedAt', 'is', null)
    .where('offerId', 'in', offers.map((o) => o.id))
    .groupBy('offerId')
    .execute();

  const serviceLines = ctx.lines.filter((l) => l.itemType === 'service');
  const weekday = isoWeekday(ctx.today);

  return offers.map((offer): OfferResult => {
    const rel = relations.get(offer.id)!;
    const fail = (reason: string): OfferResult => ({ ok: false, offer, reason });

    if (offer.status !== 'active') return fail('This offer is not active.');
    if (ctx.today < offer.validFrom) return fail(`This offer starts on ${offer.validFrom}.`);
    if (ctx.today > offer.validTo) return fail('This offer has expired.');
    if (!offer.allBranches && !rel.branches.has(ctx.branchId)) return fail('This offer is not valid at this branch.');
    if (offer.validWeekdays?.length && !offer.validWeekdays.includes(weekday)) return fail('This offer is not valid on this day of the week.');
    if (offer.usageLimitTotal !== null && offer.usageCount >= offer.usageLimitTotal) return fail('This offer has reached its usage limit.');
    const used = Number(usage.find((u) => u.offerId === offer.id)?.n ?? 0);
    if (offer.usageLimitPerCustomer !== null && used >= offer.usageLimitPerCustomer) return fail('This customer has already used this offer the maximum number of times.');

    switch (offer.eligibility) {
      case 'first_visit':
        if ((customer.visitCount ?? 0) > 0 || priorInvoices.n > 0) return fail('This offer is only for a first visit.');
        break;
      case 'birthday':
        if (!customer.dateOfBirth || !birthdayWithin(customer.dateOfBirth, ctx.today, offer.birthdayWindowDays)) return fail('This offer is only valid around the customer’s birthday.');
        break;
      case 'loyalty':
        if (offer.loyaltyMinVisits !== null && (customer.visitCount ?? 0) < offer.loyaltyMinVisits) return fail(`This offer needs at least ${offer.loyaltyMinVisits} visits.`);
        if (offer.loyaltyMinSpend !== null && (customer.lifetimeSpend ?? 0) < offer.loyaltyMinSpend) return fail(`This offer needs lifetime spend of at least ${formatMoney(offer.loyaltyMinSpend, ctx.currency)}.`);
        break;
      case 'specific_customers':
        if (!rel.customers.has(ctx.customerId)) return fail('This offer is not available for this customer.');
        break;
      default:
        break;
    }

    let eligible = serviceLines;
    if (offer.appliesTo === 'services') eligible = serviceLines.filter((l) => l.serviceId && rel.services.has(l.serviceId));
    if (offer.appliesTo === 'categories') eligible = serviceLines.filter((l) => l.categoryId && rel.categories.has(l.categoryId));
    if (offer.appliesTo === 'combo') {
      const present = new Set(serviceLines.map((l) => l.serviceId));
      const missing = [...rel.services].filter((id) => !present.has(id));
      if (missing.length) return fail('This combo offer needs all of its services on the bill.');
      eligible = serviceLines.filter((l) => l.serviceId && rel.services.has(l.serviceId));
    }
    if (!eligible.length) return fail('None of the services on this bill qualify for this offer.');
    const eligibleTotal = eligible.reduce((a, l) => a + l.gross, 0);
    if (offer.minBillAmount !== null && eligibleTotal < offer.minBillAmount) return fail(`Spend at least ${formatMoney(offer.minBillAmount, ctx.currency)} on qualifying services to use this offer.`);

    const rule: DiscountRule = { type: offer.discountType as 'percentage' | 'flat', value: offer.discountValue, maxAmount: offer.maxDiscountAmount };
    const estimate = calculateInvoice({
      lines: eligible.map((l) => ({ key: l.key, quantity: 1, unitPrice: l.gross, taxRateBp: 0, offerEligible: true, discountable: false })),
      pricesIncludeTax: false,
      offer: rule,
      roundOffTo: 1,
    }).offerDiscount;
    if (estimate <= 0) return fail('This offer would not reduce the bill.');
    return { ok: true, offer, rule, eligibleKeys: eligible.map((l) => l.key), estimated: estimate };
  });
}
