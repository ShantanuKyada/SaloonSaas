import { formatMoney, type createInvoiceSchema, type InvoiceDto, type InvoiceLineInput } from '@salon/shared';
import type { z } from 'zod';
import { DateTime } from 'luxon';
import { audit } from '../../core/audit.js';
import { assertBranchAccess, hasPermission, requireOrgId, type AuthContext } from '../../core/auth-context.js';
import { AppError, notFound } from '../../core/errors.js';
import { addDays } from '../../core/time.js';
import type { Tx } from '../../db/tenant.js';
import { addEvent, changeStatus } from '../appointments/service.js';
import { refreshCustomerStats } from '../customers/service.js';
import { allocatePayment, insertPayment, lockCustomerLedger, nextInvoiceNumber, postLedger, queueReceipt, reverseAllocation, type DocContext } from './ledger.js';
import { resolveInvoice } from './resolve.js';

// ───────────── Create ─────────────
export async function createInvoice(tx: Tx, auth: AuthContext, input: z.output<typeof createInvoiceSchema>): Promise<string> {
  const orgId = requireOrgId(auth);
  assertBranchAccess(auth, input.branchId);
  await lockCustomerLedger(tx, input.customerId);
  const r = await resolveInvoice(tx, auth, input, { strict: true });
  const doc: DocContext = { org: r.org, branch: r.branch, settings: r.settings };
  const cur = r.org.currency;
  const grand = r.calc.grandTotal;

  // Billing a service that is still running completes it first (one click for the receptionist, one audit trail).
  if (r.appointment && r.appointment.status === 'in_service') {
    await changeStatus(tx, auth, r.appointment.id, { status: 'completed', notifyCustomer: false });
  }

  // Plan how this bill is settled: advance on account, then the payments taken now; anything left is credit.
  const newPaymentTotal = input.payments.reduce((a, p) => a + p.amount, 0);
  let remaining = grand;
  const advancePlan: Array<{ paymentId: string; amount: number }> = [];
  if (input.useAdvance && remaining > 0) {
    const open = await tx
      .selectFrom('payments')
      .select(['id', 'amount', 'allocatedAmount', 'refundedAmount'])
      .where('organizationId', '=', orgId)
      .where('customerId', '=', input.customerId)
      .where('status', '=', 'completed')
      .whereRef('allocatedAmount', '<', (eb) => eb(eb.ref('amount'), '-', eb.ref('refundedAmount')))
      .orderBy('receivedAt')
      .forUpdate()
      .execute();
    for (const p of open) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, p.amount - p.allocatedAmount - p.refundedAmount);
      if (take > 0) {
        advancePlan.push({ paymentId: p.id, amount: take });
        remaining -= take;
      }
    }
  }
  const paidNowToBill = Math.min(remaining, newPaymentTotal);
  const balanceDue = remaining - paidNowToBill;

  // Credit limit: only new credit is checked, so a customer already over the limit can still pay a bill in full.
  if (balanceDue > 0 && r.customer.creditLimit !== null) {
    const outstandingAfter = Math.max(r.account.balance + grand - newPaymentTotal, 0);
    if (outstandingAfter > r.customer.creditLimit) {
      const canOverride = hasPermission(auth, 'billing.override_credit_limit');
      if (!(input.allowCreditLimitOverride && canOverride)) {
        throw new AppError(
          409,
          'CREDIT_LIMIT_EXCEEDED',
          `This bill would take ${r.customer.fullName}'s pending amount to ${formatMoney(outstandingAfter, cur)}, above their credit limit of ${formatMoney(r.customer.creditLimit, cur)}. Collect some payment now${canOverride ? ', or choose to continue anyway' : ', or ask a manager to approve it'}.`,
          { creditLimit: r.customer.creditLimit, outstandingAfter, canOverride },
        );
      }
    }
  }

  const invoiceNumber = await nextInvoiceNumber(tx, doc);
  const invoiceDate = r.today;
  const dueDate = input.dueDate ?? (balanceDue > 0 ? addDays(invoiceDate, r.settings.creditDueDays) : null);
  const invoice = await tx
    .insertInto('invoices')
    .values({
      organizationId: orgId,
      branchId: r.branch.id,
      customerId: r.customer.id,
      invoiceNumber,
      appointmentId: r.appointment?.id ?? null,
      invoiceDate,
      dueDate,
      pricesIncludeTax: r.settings.pricesIncludeTax,
      subtotal: r.calc.subtotal,
      discountTotal: r.calc.discountTotal,
      taxTotal: r.calc.taxTotal,
      roundOff: r.calc.roundOff,
      grandTotal: grand,
      balanceDue: grand,
      paymentStatus: grand === 0 ? 'paid' : 'unpaid',
      offerId: r.offer?.offer.id ?? null,
      offerDiscount: r.calc.offerDiscount,
      manualDiscount: r.calc.manualDiscount,
      manualDiscountReason: r.manualDiscount?.reason ?? null,
      notes: input.notes ?? null,
      createdBy: auth.userId,
    })
    .returning(['id', 'issuedAt'])
    .executeTakeFirstOrThrow();

  const calcByKey = new Map(r.calc.lines.map((l) => [l.key, l]));
  for (const [i, line] of r.lines.entries()) {
    const c = calcByKey.get(line.key)!;
    const item = await tx
      .insertInto('invoiceItems')
      .values({
        organizationId: orgId,
        invoiceId: invoice.id,
        lineNo: i + 1,
        itemType: line.itemType,
        serviceId: line.serviceId,
        packageId: line.packageId,
        customerPackageItemId: line.customerPackageItemId,
        appointmentItemId: line.appointmentItemId,
        staffId: line.staffId,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        grossAmount: c.gross,
        discountAmount: c.discount,
        taxRateBp: line.taxRateBp,
        taxableAmount: c.taxable,
        taxAmount: c.tax,
        lineTotal: c.total,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    if (line.itemType === 'package_redemption') {
      const used = await tx
        .updateTable('customerPackageItems')
        .set((eb) => ({ quantityUsed: eb('quantityUsed', '+', line.quantity) }))
        .where('id', '=', line.customerPackageItemId!)
        .returning(['customerPackageId'])
        .executeTakeFirstOrThrow();
      await tx.insertInto('packageRedemptions').values({ organizationId: orgId, customerPackageItemId: line.customerPackageItemId!, invoiceId: invoice.id, invoiceItemId: item.id, branchId: r.branch.id, quantity: line.quantity, redeemedBy: auth.userId }).execute();
      const left = await tx.selectFrom('customerPackageItems').select((eb) => eb.fn.sum<number>(eb('quantityTotal', '-', eb.ref('quantityUsed'))).as('left')).where('customerPackageId', '=', used.customerPackageId).executeTakeFirstOrThrow();
      if (Number(left.left) === 0) await tx.updateTable('customerPackages').set({ status: 'exhausted' }).where('id', '=', used.customerPackageId).execute();
    }

    if (line.itemType === 'package_sale') {
      const pkg = await tx.selectFrom('packages').select(['validityDays']).where('id', '=', line.packageId!).executeTakeFirstOrThrow();
      const items = await tx.selectFrom('packageItems').select(['serviceId', 'quantity']).where('packageId', '=', line.packageId!).execute();
      const owned = await tx
        .insertInto('customerPackages')
        .values({
          organizationId: orgId,
          customerId: r.customer.id,
          packageId: line.packageId!,
          branchId: r.branch.id,
          invoiceId: invoice.id,
          invoiceItemId: item.id,
          pricePaid: c.total,
          expiresAt: DateTime.now().plus({ days: pkg.validityDays }).endOf('day').toJSDate(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx.insertInto('customerPackageItems').values(items.map((it) => ({ organizationId: orgId, customerPackageId: owned.id, serviceId: it.serviceId, quantityTotal: it.quantity }))).execute();
      await tx.updateTable('packages').set((eb) => ({ soldCount: eb('soldCount', '+', 1) })).where('id', '=', line.packageId!).execute();
    }
  }

  if (grand > 0) {
    await postLedger(tx, { orgId, branchId: r.branch.id, customerId: r.customer.id, entryType: 'invoice', sourceType: 'invoice', sourceId: invoice.id, reference: invoiceNumber, description: 'Service bill', debit: grand, by: auth.userId });
  }

  if (r.offer) {
    await tx.insertInto('offerRedemptions').values({ organizationId: orgId, offerId: r.offer.offer.id, invoiceId: invoice.id, customerId: r.customer.id, discountAmount: r.calc.offerDiscount }).execute();
    await tx.updateTable('offers').set((eb) => ({ usageCount: eb('usageCount', '+', 1) })).where('id', '=', r.offer!.offer.id).execute();
  }

  for (const a of advancePlan) await allocatePayment(tx, { orgId, paymentId: a.paymentId, invoiceId: invoice.id, amount: a.amount, by: auth.userId });
  let toApply = remaining;
  const receipts: Array<Awaited<ReturnType<typeof insertPayment>>> = [];
  for (const part of input.payments) {
    const payment = await insertPayment(tx, auth, doc, { customerId: r.customer.id, amount: part.amount, method: part.method, reference: part.reference });
    const apply = Math.min(toApply, part.amount);
    if (apply > 0) await allocatePayment(tx, { orgId, paymentId: payment.id, invoiceId: invoice.id, amount: apply, by: auth.userId });
    toApply -= apply;
    receipts.push(payment);
  }

  if (r.appointment) {
    await tx.updateTable('appointments').set((eb) => ({ invoiceId: invoice.id, updatedBy: auth.userId, version: eb('version', '+', 1) })).where('id', '=', r.appointment!.id).execute();
    await addEvent(tx, auth, orgId, r.appointment.id, 'billed', { invoiceNumber, grandTotal: grand });
  }
  await refreshCustomerStats(tx, orgId, r.customer.id);
  if (input.sendReceipt !== false) for (const p of receipts) await queueReceipt(tx, auth, doc, p, r.customer.id);

  await audit(tx, auth, {
    action: 'invoice.created',
    entityType: 'invoice',
    entityId: invoice.id,
    branchId: r.branch.id,
    summary: `Bill ${invoiceNumber} for ${r.customer.fullName}: ${formatMoney(grand, cur)}${balanceDue > 0 ? ` (${formatMoney(balanceDue, cur)} on credit)` : ''}`,
    after: { invoiceNumber, grandTotal: grand, balanceDue, offer: r.offer?.offer.name, manualDiscount: r.calc.manualDiscount, payments: input.payments.map((p) => ({ method: p.method, amount: p.amount })), advanceUsed: advancePlan.reduce((a, p) => a + p.amount, 0), creditOverride: input.allowCreditLimitOverride && balanceDue > 0 },
  });
  return invoice.id;
}

// ───────────── Read ─────────────
export async function loadInvoiceDto(tx: Tx, auth: AuthContext, invoiceId: string): Promise<InvoiceDto> {
  const orgId = requireOrgId(auth);
  const i = await tx
    .selectFrom('invoices as i')
    .innerJoin('branches as b', 'b.id', 'i.branchId')
    .innerJoin('organizations as o', 'o.id', 'i.organizationId')
    .innerJoin('organizationSettings as s', 's.organizationId', 'i.organizationId')
    .innerJoin('customers as c', 'c.id', 'i.customerId')
    .innerJoin('users as u', 'u.id', 'i.createdBy')
    .leftJoin('offers as of', 'of.id', 'i.offerId')
    .selectAll('i')
    .select([
      'b.name as branchName',
      'b.addressLine1 as branchAddress',
      'b.phone as branchPhone',
      'o.name as orgName',
      'o.legalName',
      'o.taxId',
      'o.taxLabel',
      'o.currency',
      's.receiptFooter',
      'c.fullName as customerName',
      'c.mobile as customerMobile',
      'c.customerCode',
      'u.fullName as createdByName',
      'of.name as offerName',
    ])
    .where('i.organizationId', '=', orgId)
    .where('i.id', '=', invoiceId)
    .executeTakeFirst();
  if (!i) throw notFound('Bill');
  assertBranchAccess(auth, i.branchId);

  const [lines, payments, adjustments] = await Promise.all([
    tx
      .selectFrom('invoiceItems as ii')
      .leftJoin('staff as st', 'st.id', 'ii.staffId')
      .selectAll('ii')
      .select('st.displayName as staffName')
      .where('ii.invoiceId', '=', invoiceId)
      .orderBy('ii.lineNo')
      .execute(),
    tx
      .selectFrom('paymentAllocations as pa')
      .innerJoin('payments as p', 'p.id', 'pa.paymentId')
      .select(['p.id as paymentId', 'p.receiptNumber', 'p.method', 'pa.amount', 'p.receivedAt'])
      .where('pa.invoiceId', '=', invoiceId)
      .where('pa.reversedAt', 'is', null)
      .orderBy('p.receivedAt')
      .execute(),
    tx.selectFrom('ledgerAdjustments').select(['id', 'adjustmentNumber', 'adjustmentType', 'amount', 'reason', 'createdAt']).where('invoiceId', '=', invoiceId).orderBy('createdAt').execute(),
  ]);

  return {
    id: i.id,
    invoiceNumber: i.invoiceNumber,
    invoiceDate: i.invoiceDate,
    branchId: i.branchId,
    branchName: i.branchName,
    customerName: i.customerName,
    customerId: i.customerId,
    grandTotal: i.grandTotal,
    amountPaid: i.amountPaid,
    amountAdjusted: i.amountAdjusted,
    balanceDue: i.balanceDue,
    paymentStatus: i.paymentStatus as InvoiceDto['paymentStatus'],
    status: i.status as 'issued' | 'void',
    branch: { name: i.branchName, address: i.branchAddress, phone: i.branchPhone },
    organization: { name: i.orgName, legalName: i.legalName, taxId: i.taxId, taxLabel: i.taxLabel, currency: i.currency, receiptFooter: i.receiptFooter },
    customer: { id: i.customerId, fullName: i.customerName, mobile: hasPermission(auth, 'customers.view_contact') ? i.customerMobile : null, customerCode: i.customerCode },
    appointmentId: i.appointmentId,
    issuedAt: i.issuedAt.toISOString(),
    dueDate: i.dueDate,
    pricesIncludeTax: i.pricesIncludeTax,
    subtotal: i.subtotal,
    discountTotal: i.discountTotal,
    offerDiscount: i.offerDiscount,
    offerName: i.offerName,
    manualDiscount: i.manualDiscount,
    manualDiscountReason: i.manualDiscountReason,
    taxTotal: i.taxTotal,
    roundOff: i.roundOff,
    notes: i.notes,
    lines: lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      itemType: l.itemType,
      description: l.description,
      serviceId: l.serviceId,
      staffId: l.staffId,
      staffName: l.staffName,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      grossAmount: l.grossAmount,
      discountAmount: l.discountAmount,
      taxRateBp: l.taxRateBp,
      taxableAmount: l.taxableAmount,
      taxAmount: l.taxAmount,
      lineTotal: l.lineTotal,
    })),
    payments: payments.map((p) => ({ paymentId: p.paymentId, receiptNumber: p.receiptNumber, method: p.method as InvoiceDto['payments'][number]['method'], amount: p.amount, receivedAt: p.receivedAt.toISOString() })),
    adjustments: adjustments.map((a) => ({ id: a.id, adjustmentNumber: a.adjustmentNumber, type: a.adjustmentType, amount: a.amount, reason: a.reason, createdAt: a.createdAt.toISOString() })),
    createdByName: i.createdByName,
    voidedAt: i.voidedAt?.toISOString() ?? null,
    voidReason: i.voidReason,
  };
}

// ───────────── Void ─────────────
export async function voidInvoice(tx: Tx, auth: AuthContext, invoiceId: string, reason: string): Promise<void> {
  const orgId = requireOrgId(auth);
  const peek = await tx.selectFrom('invoices').select(['customerId', 'branchId']).where('organizationId', '=', orgId).where('id', '=', invoiceId).executeTakeFirst();
  if (!peek) throw notFound('Bill');
  assertBranchAccess(auth, peek.branchId);
  await lockCustomerLedger(tx, peek.customerId);
  const invoice = await tx.selectFrom('invoices').selectAll().where('id', '=', invoiceId).forUpdate().executeTakeFirstOrThrow();
  if (invoice.status === 'void') throw new AppError(409, 'CONFLICT', 'This bill is already cancelled.');

  const sold = await tx.selectFrom('customerPackages').select(['id']).where('invoiceId', '=', invoiceId).where('status', '!=', 'cancelled').execute();
  for (const pkg of sold) {
    const used = await tx.selectFrom('customerPackageItems').select((eb) => eb.fn.sum<number>('quantityUsed').as('n')).where('customerPackageId', '=', pkg.id).executeTakeFirstOrThrow();
    if (Number(used.n ?? 0) > 0) throw new AppError(409, 'PACKAGE_UNAVAILABLE', 'A package on this bill has already been used. Cancel the services that used it first, or post an adjustment instead.');
  }

  // Payments stay on the customer's account as advance (they can be refunded); only the allocations are undone.
  const allocations = await tx.selectFrom('paymentAllocations').select(['id', 'paymentId', 'invoiceId', 'amount']).where('invoiceId', '=', invoiceId).where('reversedAt', 'is', null).forUpdate().execute();
  for (const a of allocations) await reverseAllocation(tx, a, 'Bill cancelled', auth.userId);

  const fresh = await tx.selectFrom('invoices').select(['amountAdjusted']).where('id', '=', invoiceId).executeTakeFirstOrThrow();
  const toCredit = invoice.grandTotal - fresh.amountAdjusted;
  await tx
    .updateTable('invoices')
    .set({ status: 'void', paymentStatus: 'void', amountPaid: 0, amountAdjusted: 0, balanceDue: 0, voidedAt: new Date(), voidedBy: auth.userId, voidReason: reason })
    .where('id', '=', invoiceId)
    .execute();
  if (toCredit > 0) {
    await postLedger(tx, { orgId, branchId: invoice.branchId, customerId: invoice.customerId, entryType: 'invoice_void', sourceType: 'invoice', sourceId: invoiceId, reference: invoice.invoiceNumber, description: `Bill cancelled: ${reason}`, credit: toCredit, by: auth.userId });
  }

  // Give back package sessions and offer uses.
  const redemptions = await tx.selectFrom('packageRedemptions').select(['id', 'customerPackageItemId', 'quantity']).where('invoiceId', '=', invoiceId).where('reversedAt', 'is', null).execute();
  for (const rd of redemptions) {
    await tx.updateTable('packageRedemptions').set({ reversedAt: new Date(), reversedBy: auth.userId }).where('id', '=', rd.id).execute();
    const cpi = await tx.updateTable('customerPackageItems').set((eb) => ({ quantityUsed: eb('quantityUsed', '-', rd.quantity) })).where('id', '=', rd.customerPackageItemId).returning('customerPackageId').executeTakeFirstOrThrow();
    await tx.updateTable('customerPackages').set({ status: 'active' }).where('id', '=', cpi.customerPackageId).where('status', '=', 'exhausted').execute();
  }
  for (const pkg of sold) {
    await tx.updateTable('customerPackages').set({ status: 'cancelled' }).where('id', '=', pkg.id).execute();
    const row = await tx.selectFrom('customerPackages').select('packageId').where('id', '=', pkg.id).executeTakeFirstOrThrow();
    await tx.updateTable('packages').set((eb) => ({ soldCount: eb('soldCount', '-', 1) })).where('id', '=', row.packageId).execute();
  }
  const offerUse = await tx.updateTable('offerRedemptions').set({ reversedAt: new Date() }).where('invoiceId', '=', invoiceId).where('reversedAt', 'is', null).returning('offerId').executeTakeFirst();
  if (offerUse) await tx.updateTable('offers').set((eb) => ({ usageCount: eb('usageCount', '-', 1) })).where('id', '=', offerUse.offerId).execute();

  if (invoice.appointmentId) {
    await tx.updateTable('appointments').set((eb) => ({ invoiceId: null, version: eb('version', '+', 1) })).where('id', '=', invoice.appointmentId).execute();
    await addEvent(tx, auth, orgId, invoice.appointmentId, 'billed', { voided: invoice.invoiceNumber, reason });
  }
  await refreshCustomerStats(tx, orgId, invoice.customerId);
  await audit(tx, auth, { action: 'invoice.voided', entityType: 'invoice', entityId: invoiceId, branchId: invoice.branchId, summary: `Bill ${invoice.invoiceNumber} cancelled: ${reason}`, before: { status: 'issued', grandTotal: invoice.grandTotal, amountPaid: invoice.amountPaid }, after: { status: 'void', reason } });
}

// ───────────── Draft from appointment ─────────────
export async function draftFromAppointment(tx: Tx, auth: AuthContext, appointmentId: string): Promise<{ branchId: string; customerId: string; appointmentId: string; bookingNumber: string; lines: InvoiceLineInput[] }> {
  const orgId = requireOrgId(auth);
  const a = await tx.selectFrom('appointments').select(['id', 'branchId', 'customerId', 'bookingNumber', 'invoiceId', 'status']).where('organizationId', '=', orgId).where('id', '=', appointmentId).executeTakeFirst();
  if (!a) throw notFound('Appointment');
  assertBranchAccess(auth, a.branchId);
  if (a.invoiceId) throw new AppError(409, 'APPOINTMENT_ALREADY_BILLED', 'This appointment has already been billed.');
  const items = await tx
    .selectFrom('appointmentItems')
    .select(['id', 'serviceId', 'staffId', 'customerPackageItemId'])
    .where('appointmentId', '=', appointmentId)
    .where('status', '!=', 'cancelled')
    .orderBy('sortOrder')
    .execute();
  const lines: InvoiceLineInput[] = items.map((i) =>
    i.customerPackageItemId
      ? { type: 'package_redemption', key: i.id, customerPackageItemId: i.customerPackageItemId, staffId: i.staffId, appointmentItemId: i.id, quantity: 1 }
      : { type: 'service', key: i.id, serviceId: i.serviceId, staffId: i.staffId, appointmentItemId: i.id, quantity: 1 },
  );
  return { branchId: a.branchId, customerId: a.customerId, appointmentId: a.id, bookingNumber: a.bookingNumber, lines };
}

