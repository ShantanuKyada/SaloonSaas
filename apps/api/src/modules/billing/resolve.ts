import { calculateInvoice, formatMoney, type DiscountRule, type InvoiceCalc, type InvoicePreview, type invoiceDraftSchema } from '@salon/shared';
import type { z } from 'zod';
import { assertBranchAccess, hasPermission, requireOrgId, type AuthContext } from '../../core/auth-context.js';
import { AppError, notFound } from '../../core/errors.js';
import { localDateOf } from '../../core/time.js';
import { loadBranch, loadOrg, loadSettings, type BranchRow, type OrgContext, type OrgSettings } from '../../core/validation.js';
import type { Tx } from '../../db/tenant.js';
import { evaluateOffers, loadOffers, type OfferResult } from '../offers/evaluate.js';
import { loadServicesForBranch } from '../scheduling/loader.js';

export type InvoiceDraft = z.output<typeof invoiceDraftSchema>;

export interface ResolvedLine {
  key: string;
  itemType: 'service' | 'package_sale' | 'package_redemption' | 'custom';
  serviceId: string | null;
  categoryId: string | null;
  packageId: string | null;
  customerPackageItemId: string | null;
  appointmentItemId: string | null;
  staffId: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRateBp: number;
  offerEligible: boolean;
  discountable: boolean;
}

export interface Resolved {
  org: OrgContext;
  branch: BranchRow;
  settings: OrgSettings;
  today: string;
  customer: { id: string; fullName: string; creditLimit: number | null; status: string };
  account: { balance: number; outstanding: number; advance: number };
  appointment: { id: string; status: string; version: number; bookingNumber: string } | null;
  lines: ResolvedLine[];
  calc: InvoiceCalc;
  offer: Extract<OfferResult, { ok: true }> | null;
  offerMessage: string | null;
  manualDiscount: { rule: DiscountRule; reason: string } | null;
  applicableOffers: InvoicePreview['applicableOffers'];
}

export interface ResolveOptions {
  /** true when creating the invoice: invalid offers are errors and rows are locked. */
  strict: boolean;
  listOffers?: boolean;
}

export async function resolveInvoice(tx: Tx, auth: AuthContext, input: InvoiceDraft, opts: ResolveOptions): Promise<Resolved> {
  const orgId = requireOrgId(auth);
  assertBranchAccess(auth, input.branchId);
  const [org, branch, settings] = await Promise.all([loadOrg(tx, orgId), loadBranch(tx, orgId, input.branchId), loadSettings(tx, orgId)]);
  const today = localDateOf(new Date(), branch.timezone);

  const customer = await tx
    .selectFrom('customers')
    .select(['id', 'fullName', 'creditLimit', 'status'])
    .where('organizationId', '=', orgId)
    .where('id', '=', input.customerId)
    .executeTakeFirst();
  if (!customer) throw notFound('Customer');
  if (customer.status === 'archived') throw new AppError(409, 'CONFLICT', 'This customer has been archived. Restore them before billing.');
  const acct = await tx.selectFrom('customerAccounts').select('balance').where('customerId', '=', customer.id).executeTakeFirst();
  const balance = acct?.balance ?? 0;

  let appointment: Resolved['appointment'] = null;
  const appointmentItems = new Map<string, { id: string; serviceId: string; staffId: string | null; price: number; customerPackageItemId: string | null }>();
  if (input.appointmentId) {
    const a = await tx
      .selectFrom('appointments')
      .select(['id', 'status', 'version', 'bookingNumber', 'branchId', 'customerId', 'invoiceId'])
      .where('organizationId', '=', orgId)
      .where('id', '=', input.appointmentId)
      .executeTakeFirst();
    if (!a) throw notFound('Appointment');
    if (a.branchId !== branch.id || a.customerId !== customer.id) throw new AppError(409, 'CONFLICT', 'This appointment belongs to a different customer or branch.');
    if (a.invoiceId) throw new AppError(409, 'APPOINTMENT_ALREADY_BILLED', 'This appointment has already been billed.');
    if (!['completed', 'in_service'].includes(a.status)) {
      throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'Start and complete the service before billing it.');
    }
    appointment = { id: a.id, status: a.status, version: a.version, bookingNumber: a.bookingNumber };
    const items = await tx
      .selectFrom('appointmentItems')
      .select(['id', 'serviceId', 'staffId', 'price', 'customerPackageItemId'])
      .where('appointmentId', '=', a.id)
      .where('status', '!=', 'cancelled')
      .execute();
    for (const i of items) appointmentItems.set(i.id, i);
  }

  // Resolve every line into a priced, taxed record.
  const serviceIds = input.lines.flatMap((l) => (l.type === 'service' ? [l.serviceId] : []));
  const cpiIds = input.lines.flatMap((l) => (l.type === 'package_redemption' ? [l.customerPackageItemId] : []));
  const packageIds = input.lines.flatMap((l) => (l.type === 'package_sale' ? [l.packageId] : []));

  const cpiRows = new Map<string, { id: string; serviceId: string; serviceName: string; quantityTotal: number; quantityUsed: number; packageName: string; status: string; expiresAt: Date; customerId: string }>();
  if (cpiIds.length) {
    let q = tx
      .selectFrom('customerPackageItems as cpi')
      .innerJoin('customerPackages as cp', 'cp.id', 'cpi.customerPackageId')
      .innerJoin('packages as p', 'p.id', 'cp.packageId')
      .innerJoin('services as s', 's.id', 'cpi.serviceId')
      .select(['cpi.id', 'cpi.serviceId', 's.name as serviceName', 'cpi.quantityTotal', 'cpi.quantityUsed', 'p.name as packageName', 'cp.status', 'cp.expiresAt', 'cp.customerId'])
      .where('cpi.organizationId', '=', orgId)
      .where('cpi.id', 'in', cpiIds);
    if (opts.strict) q = q.forUpdate('cpi');
    for (const r of await q.execute()) cpiRows.set(r.id, r);
  }
  const serviceMap = serviceIds.length ? await loadServicesForBranch(tx, orgId, branch.id, serviceIds) : new Map();
  const categoryByService = new Map<string, string>();
  const allServiceIds = [...new Set([...serviceIds, ...[...cpiRows.values()].map((c) => c.serviceId)])];
  if (allServiceIds.length) {
    for (const s of await tx.selectFrom('services').select(['id', 'categoryId']).where('organizationId', '=', orgId).where('id', 'in', allServiceIds).execute()) categoryByService.set(s.id, s.categoryId);
  }
  const staffIds = [...new Set(input.lines.map((l) => ('staffId' in l ? l.staffId : null)).filter((v): v is string => !!v))];
  const staffRows = staffIds.length
    ? await tx.selectFrom('staff').select(['id', 'displayName', 'branchId']).where('organizationId', '=', orgId).where('id', 'in', staffIds).execute()
    : [];
  const staffOverrides = serviceIds.length && staffIds.length
    ? await tx.selectFrom('staffServices').select(['staffId', 'serviceId', 'priceOverride']).where('staffId', 'in', staffIds).where('serviceId', 'in', serviceIds).execute()
    : [];
  const packageRows = new Map<string, Awaited<ReturnType<typeof loadPackages>>[number]>();
  if (packageIds.length) for (const p of await loadPackages(tx, orgId, packageIds)) packageRows.set(p.id, p);

  const lines: ResolvedLine[] = [];
  const usedCpiQty = new Map<string, number>();
  for (const l of input.lines) {
    const staffId = ('staffId' in l ? l.staffId : null) ?? null;
    if (staffId && !staffRows.some((s) => s.id === staffId)) throw new AppError(400, 'BAD_REQUEST', 'One of the selected team members could not be found.');

    if (l.type === 'service') {
      const info = serviceMap.get(l.serviceId)!;
      const apptItem = l.appointmentItemId ? appointmentItems.get(l.appointmentItemId) : undefined;
      if (l.appointmentItemId && (!apptItem || apptItem.serviceId !== l.serviceId)) throw new AppError(409, 'CONFLICT', 'A service on this bill does not match the appointment.');
      const override = staffOverrides.find((o) => o.staffId === (staffId ?? apptItem?.staffId) && o.serviceId === l.serviceId)?.priceOverride;
      lines.push({
        key: l.key,
        itemType: 'service',
        serviceId: l.serviceId,
        categoryId: categoryByService.get(l.serviceId) ?? null,
        packageId: null,
        customerPackageItemId: null,
        appointmentItemId: l.appointmentItemId ?? null,
        staffId: staffId ?? apptItem?.staffId ?? null,
        description: info.name,
        quantity: l.quantity,
        unitPrice: apptItem ? apptItem.price : (override ?? info.price),
        taxRateBp: info.taxRateBp ?? settings.defaultTaxRateBp,
        offerEligible: true,
        discountable: true,
      });
    } else if (l.type === 'package_redemption') {
      const cpi = cpiRows.get(l.customerPackageItemId);
      if (!cpi || cpi.customerId !== customer.id) throw new AppError(422, 'PACKAGE_UNAVAILABLE', 'This package does not belong to the selected customer.');
      if (cpi.status !== 'active') throw new AppError(422, 'PACKAGE_UNAVAILABLE', `${cpi.packageName} is no longer active.`);
      if (cpi.expiresAt.getTime() < Date.now()) throw new AppError(422, 'PACKAGE_UNAVAILABLE', `${cpi.packageName} has expired.`);
      const already = usedCpiQty.get(cpi.id) ?? 0;
      if (cpi.quantityUsed + already + l.quantity > cpi.quantityTotal) throw new AppError(422, 'PACKAGE_UNAVAILABLE', `No sessions of ${cpi.serviceName} are left in ${cpi.packageName}.`);
      usedCpiQty.set(cpi.id, already + l.quantity);
      const apptItem = l.appointmentItemId ? appointmentItems.get(l.appointmentItemId) : undefined;
      lines.push({
        key: l.key,
        itemType: 'package_redemption',
        serviceId: cpi.serviceId,
        categoryId: categoryByService.get(cpi.serviceId) ?? null,
        packageId: null,
        customerPackageItemId: cpi.id,
        appointmentItemId: l.appointmentItemId ?? null,
        staffId: staffId ?? apptItem?.staffId ?? null,
        description: `${cpi.serviceName} (package: ${cpi.packageName})`,
        quantity: l.quantity,
        unitPrice: 0,
        taxRateBp: 0,
        offerEligible: false,
        discountable: false,
      });
    } else if (l.type === 'package_sale') {
      const pkg = packageRows.get(l.packageId);
      if (!pkg) throw notFound('Package');
      await assertPackageSellable(tx, orgId, branch.id, customer.id, today, pkg, opts.strict);
      lines.push({
        key: l.key,
        itemType: 'package_sale',
        serviceId: null,
        categoryId: null,
        packageId: pkg.id,
        customerPackageItemId: null,
        appointmentItemId: null,
        staffId,
        description: `Package: ${pkg.name}`,
        quantity: 1,
        unitPrice: pkg.price,
        taxRateBp: pkg.taxRateBp ?? settings.defaultTaxRateBp,
        offerEligible: false,
        discountable: true,
      });
    } else {
      lines.push({
        key: l.key,
        itemType: 'custom',
        serviceId: null,
        categoryId: null,
        packageId: null,
        customerPackageItemId: null,
        appointmentItemId: null,
        staffId,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        taxRateBp: l.taxRateBp ?? settings.defaultTaxRateBp,
        offerEligible: false,
        discountable: true,
      });
    }
  }
  const keys = new Set(lines.map((l) => l.key));
  if (keys.size !== lines.length) throw new AppError(400, 'VALIDATION_ERROR', 'Each line on the bill needs a unique key.');

  // Offer selection and validation.
  const offerCtx = {
    orgId,
    branchId: branch.id,
    today,
    currency: org.currency,
    customerId: customer.id,
    lines: lines.map((l) => ({ key: l.key, itemType: l.itemType, serviceId: l.serviceId, categoryId: l.categoryId, gross: l.quantity * l.unitPrice })),
  };
  let offer: Resolved['offer'] = null;
  let offerMessage: string | null = null;
  if (input.offerId || input.offerCode) {
    const found = await loadOffers(tx, orgId, input.offerId ? { id: input.offerId } : { code: input.offerCode! });
    if (!found.length) {
      offerMessage = 'This offer code is not valid or is no longer active.';
    } else {
      if (opts.strict) {
        // Lock the offer row so concurrent bills cannot both take the last redemption.
        await tx.selectFrom('offers').select('id').where('id', '=', found[0]!.id).forUpdate().execute();
      }
      const fresh = opts.strict ? await loadOffers(tx, orgId, { id: found[0]!.id }) : found;
      const [result] = await evaluateOffers(tx, offerCtx, fresh);
      if (result!.ok) offer = result!;
      else offerMessage = result!.reason;
    }
    if (offerMessage && opts.strict) throw new AppError(422, 'OFFER_INVALID', offerMessage);
  }

  let manualDiscount: Resolved['manualDiscount'] = null;
  if (input.manualDiscount) {
    if (!hasPermission(auth, 'billing.discount')) throw new AppError(403, 'FORBIDDEN', 'Only a manager can give a manual discount.');
    manualDiscount = { rule: { type: input.manualDiscount.type, value: input.manualDiscount.value }, reason: input.manualDiscount.reason };
  }

  const eligibleKeys = new Set(offer?.eligibleKeys ?? []);
  const calc = calculateInvoice({
    lines: lines.map((l) => ({ key: l.key, quantity: l.quantity, unitPrice: l.unitPrice, taxRateBp: l.taxRateBp, offerEligible: eligibleKeys.has(l.key), discountable: l.discountable })),
    pricesIncludeTax: settings.pricesIncludeTax,
    offer: offer?.rule ?? null,
    manualDiscount: manualDiscount?.rule ?? null,
    roundOffTo: settings.roundOffToMinor,
  });

  let applicableOffers: InvoicePreview['applicableOffers'] = [];
  if (opts.listOffers) {
    const candidates = (await loadOffers(tx, orgId)).filter((o) => today >= o.validFrom && today <= o.validTo);
    const results = await evaluateOffers(tx, offerCtx, candidates);
    applicableOffers = results
      .filter((r): r is Extract<OfferResult, { ok: true }> => r.ok)
      .map((r) => ({ id: r.offer.id, name: r.offer.name, code: r.offer.code, estimatedDiscount: r.estimated, autoApply: r.offer.autoApply }))
      .sort((a, b) => b.estimatedDiscount - a.estimatedDiscount);
  }

  return {
    org,
    branch,
    settings,
    today,
    customer: { id: customer.id, fullName: customer.fullName, creditLimit: customer.creditLimit, status: customer.status },
    account: { balance, outstanding: Math.max(balance, 0), advance: Math.max(-balance, 0) },
    appointment,
    lines,
    calc,
    offer,
    offerMessage,
    manualDiscount,
    applicableOffers,
  };
}

async function loadPackages(tx: Tx, orgId: string, ids: string[]) {
  return tx.selectFrom('packages').selectAll().where('organizationId', '=', orgId).where('id', 'in', ids).execute();
}

async function assertPackageSellable(tx: Tx, orgId: string, branchId: string, customerId: string, today: string, pkg: Awaited<ReturnType<typeof loadPackages>>[number], lock: boolean): Promise<void> {
  if (lock) await tx.selectFrom('packages').select('id').where('id', '=', pkg.id).forUpdate().execute();
  const fresh = lock ? (await loadPackages(tx, orgId, [pkg.id]))[0]! : pkg;
  if (fresh.status !== 'active') throw new AppError(422, 'PACKAGE_UNAVAILABLE', `"${fresh.name}" is not available for sale.`);
  if (fresh.saleStartsOn && today < fresh.saleStartsOn) throw new AppError(422, 'PACKAGE_UNAVAILABLE', `"${fresh.name}" goes on sale on ${fresh.saleStartsOn}.`);
  if (fresh.saleEndsOn && today > fresh.saleEndsOn) throw new AppError(422, 'PACKAGE_UNAVAILABLE', `"${fresh.name}" is no longer on sale.`);
  if (fresh.saleLimitTotal !== null && fresh.soldCount >= fresh.saleLimitTotal) throw new AppError(422, 'PACKAGE_UNAVAILABLE', `"${fresh.name}" is sold out.`);
  if (!fresh.allBranches) {
    const ok = await tx.selectFrom('packageBranches').select('branchId').where('packageId', '=', fresh.id).where('branchId', '=', branchId).executeTakeFirst();
    if (!ok) throw new AppError(422, 'PACKAGE_UNAVAILABLE', `"${fresh.name}" is not sold at this branch.`);
  }
  if (fresh.customerSegment !== 'all') {
    const prior = await tx
      .selectFrom('invoices')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('organizationId', '=', orgId)
      .where('customerId', '=', customerId)
      .where('status', '=', 'issued')
      .executeTakeFirstOrThrow();
    if (fresh.customerSegment === 'new_customers' && prior.n > 0) throw new AppError(422, 'PACKAGE_UNAVAILABLE', `"${fresh.name}" is only for new customers.`);
    if (fresh.customerSegment === 'existing_customers' && prior.n === 0) throw new AppError(422, 'PACKAGE_UNAVAILABLE', `"${fresh.name}" is only for returning customers.`);
  }
  if (fresh.maxPerCustomer !== null) {
    const owned = await tx
      .selectFrom('customerPackages')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('organizationId', '=', orgId)
      .where('customerId', '=', customerId)
      .where('packageId', '=', fresh.id)
      .where('status', '!=', 'cancelled')
      .executeTakeFirstOrThrow();
    if (owned.n >= fresh.maxPerCustomer) throw new AppError(422, 'PACKAGE_UNAVAILABLE', `This customer already has the maximum number of "${fresh.name}" packages.`);
  }
}

export function previewFrom(r: Resolved): InvoicePreview {
  const warnings: string[] = [];
  const cur = r.org.currency;
  if (r.account.outstanding > 0) warnings.push(`${formatMoney(r.account.outstanding, cur)} already pending from earlier visits.`);
  if (r.customer.creditLimit !== null && r.account.outstanding + r.calc.grandTotal > r.customer.creditLimit) {
    warnings.push(`If this bill is not paid now, the customer will be over their credit limit of ${formatMoney(r.customer.creditLimit, cur)}.`);
  }
  if (r.account.advance > 0) warnings.push(`Customer has ${formatMoney(r.account.advance, cur)} paid in advance that can be used on this bill.`);
  const byKey = new Map(r.calc.lines.map((l) => [l.key, l]));
  return {
    lines: r.lines.map((l) => {
      const c = byKey.get(l.key)!;
      return { key: l.key, description: l.description, itemType: l.itemType, quantity: l.quantity, unitPrice: l.unitPrice, gross: c.gross, discount: c.discount, taxRateBp: l.taxRateBp, tax: c.tax, total: c.total, staffId: l.staffId };
    }),
    subtotal: r.calc.subtotal,
    offerDiscount: r.calc.offerDiscount,
    manualDiscount: r.calc.manualDiscount,
    discountTotal: r.calc.discountTotal,
    taxTotal: r.calc.taxTotal,
    roundOff: r.calc.roundOff,
    grandTotal: r.calc.grandTotal,
    offer: r.offer ? { id: r.offer.offer.id, name: r.offer.offer.name, code: r.offer.offer.code } : null,
    offerMessage: r.offerMessage,
    applicableOffers: r.applicableOffers,
    customerAccount: {
      outstanding: r.account.outstanding,
      advance: r.account.advance,
      creditLimit: r.customer.creditLimit,
      availableCredit: r.customer.creditLimit === null ? null : Math.max(r.customer.creditLimit - r.account.outstanding, 0),
    },
    warnings,
  };
}
