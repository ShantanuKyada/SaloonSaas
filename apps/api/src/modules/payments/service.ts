import { formatMoney, type adjustmentSchema, type collectPaymentSchema, type PaymentDto, type refundSchema } from '@salon/shared';
import type { z } from 'zod';
import { audit } from '../../core/audit.js';
import { assertBranchAccess, hasPermission, requireOrgId, type AuthContext } from '../../core/auth-context.js';
import { AppError, notFound } from '../../core/errors.js';
import { loadBranch, loadOrg, loadSettings } from '../../core/validation.js';
import type { Tx } from '../../db/tenant.js';
import { allocatePayment, customerBalance, insertPayment, lockCustomerLedger, nextAdjustmentNumber, postLedger, queueReceipt, reverseAllocation, settlementStatus, type DocContext } from '../billing/ledger.js';

type CollectInput = z.output<typeof collectPaymentSchema>;
type RefundIn = z.output<typeof refundSchema>;
type AdjustIn = z.output<typeof adjustmentSchema>;

async function docContext(tx: Tx, orgId: string, branchId: string): Promise<DocContext> {
  const [org, branch, settings] = await Promise.all([loadOrg(tx, orgId), loadBranch(tx, orgId, branchId), loadSettings(tx, orgId)]);
  return { org, branch, settings };
}

// ───────────── Collect ─────────────
export async function collectPayment(tx: Tx, auth: AuthContext, input: CollectInput): Promise<string> {
  const orgId = requireOrgId(auth);
  assertBranchAccess(auth, input.branchId);
  await lockCustomerLedger(tx, input.customerId);
  const doc = await docContext(tx, orgId, input.branchId);
  const customer = await tx.selectFrom('customers').select(['id', 'fullName', 'status']).where('organizationId', '=', orgId).where('id', '=', input.customerId).executeTakeFirst();
  if (!customer) throw notFound('Customer');
  if (customer.status === 'archived') throw new AppError(409, 'CONFLICT', 'This customer has been archived.');

  // Only bills at branches this user can access are collectable from here.
  const open = await tx
    .selectFrom('invoices')
    .select(['id', 'invoiceNumber', 'balanceDue'])
    .where('organizationId', '=', orgId)
    .where('customerId', '=', customer.id)
    .where('status', '=', 'issued')
    .where('balanceDue', '>', 0)
    .where('branchId', 'in', auth.branchIds.length ? auth.branchIds : ['00000000-0000-0000-0000-000000000000'])
    .orderBy('invoiceDate')
    .orderBy('issuedAt')
    .forUpdate()
    .execute();

  const plan: Array<{ invoiceId: string; amount: number }> = [];
  if (input.allocations) {
    const seen = new Set<string>();
    for (const a of input.allocations) {
      const inv = open.find((o) => o.id === a.invoiceId);
      if (!inv) throw new AppError(422, 'INVOICE_NOT_PAYABLE', 'One of the selected bills is not pending or does not belong to this customer.');
      if (seen.has(a.invoiceId)) throw new AppError(400, 'BAD_REQUEST', 'A bill can only be selected once.');
      seen.add(a.invoiceId);
      if (a.amount > inv.balanceDue) throw new AppError(422, 'PAYMENT_EXCEEDS_BALANCE', `${inv.invoiceNumber} only has ${formatMoney(inv.balanceDue, doc.org.currency)} pending.`, { invoiceId: inv.id, balanceDue: inv.balanceDue });
      plan.push(a);
    }
    if (plan.reduce((s, a) => s + a.amount, 0) > input.amount) throw new AppError(422, 'PAYMENT_EXCEEDS_BALANCE', 'The amounts applied to bills add up to more than the payment received.');
  } else {
    let left = input.amount;
    for (const inv of open) {
      if (left <= 0) break;
      const take = Math.min(left, inv.balanceDue);
      plan.push({ invoiceId: inv.id, amount: take });
      left -= take;
    }
  }

  const payment = await insertPayment(tx, auth, doc, { customerId: customer.id, amount: input.amount, method: input.method, reference: input.reference, notes: input.notes });
  for (const a of plan) await allocatePayment(tx, { orgId, paymentId: payment.id, invoiceId: a.invoiceId, amount: a.amount, by: auth.userId });
  if (input.sendReceipt !== false) await queueReceipt(tx, auth, doc, payment, customer.id);
  const applied = plan.reduce((s, a) => s + a.amount, 0);
  await audit(tx, auth, {
    action: 'payment.received',
    entityType: 'payment',
    entityId: payment.id,
    branchId: input.branchId,
    summary: `Received ${formatMoney(input.amount, doc.org.currency)} from ${customer.fullName} (${payment.receiptNumber})`,
    after: { receiptNumber: payment.receiptNumber, amount: input.amount, method: input.method, appliedToBills: plan.length, advanceKept: input.amount - applied },
  });
  return payment.id;
}

// ───────────── Void ─────────────
export async function voidPayment(tx: Tx, auth: AuthContext, paymentId: string, reason: string): Promise<void> {
  const orgId = requireOrgId(auth);
  const peek = await tx.selectFrom('payments').select(['customerId', 'branchId']).where('organizationId', '=', orgId).where('id', '=', paymentId).executeTakeFirst();
  if (!peek) throw notFound('Payment');
  assertBranchAccess(auth, peek.branchId);
  await lockCustomerLedger(tx, peek.customerId);
  const payment = await tx.selectFrom('payments').selectAll().where('id', '=', paymentId).forUpdate().executeTakeFirstOrThrow();
  if (payment.status === 'void') throw new AppError(409, 'CONFLICT', 'This payment is already cancelled.');
  if (payment.refundedAmount > 0) throw new AppError(409, 'CONFLICT', 'Part of this payment was refunded, so it cannot be cancelled.');

  const allocations = await tx.selectFrom('paymentAllocations').select(['id', 'paymentId', 'invoiceId', 'amount']).where('paymentId', '=', paymentId).where('reversedAt', 'is', null).forUpdate().execute();
  for (const a of allocations) {
    await tx.selectFrom('invoices').select('id').where('id', '=', a.invoiceId).forUpdate().execute();
    await reverseAllocation(tx, a, `Payment ${payment.receiptNumber} cancelled`, auth.userId);
  }
  await tx.updateTable('payments').set({ status: 'void', voidedAt: new Date(), voidedBy: auth.userId, voidReason: reason }).where('id', '=', paymentId).execute();
  await postLedger(tx, { orgId, branchId: payment.branchId, customerId: payment.customerId, entryType: 'payment_void', sourceType: 'payment', sourceId: paymentId, reference: payment.receiptNumber, description: `Payment cancelled: ${reason}`, debit: payment.amount, by: auth.userId });
  await audit(tx, auth, { action: 'payment.voided', entityType: 'payment', entityId: paymentId, branchId: payment.branchId, summary: `Payment ${payment.receiptNumber} cancelled: ${reason}`, before: { status: 'completed', amount: payment.amount }, after: { status: 'void', reason } });
}

// ───────────── Refund ─────────────
export async function refundPayment(tx: Tx, auth: AuthContext, input: RefundIn): Promise<string> {
  const orgId = requireOrgId(auth);
  const peek = await tx.selectFrom('payments').select(['customerId', 'branchId']).where('organizationId', '=', orgId).where('id', '=', input.paymentId).executeTakeFirst();
  if (!peek) throw notFound('Payment');
  assertBranchAccess(auth, peek.branchId);
  await lockCustomerLedger(tx, peek.customerId);
  const payment = await tx.selectFrom('payments').selectAll().where('id', '=', input.paymentId).forUpdate().executeTakeFirstOrThrow();
  if (payment.status !== 'completed') throw new AppError(409, 'CONFLICT', 'A cancelled payment cannot be refunded.');
  const refundable = payment.amount - payment.refundedAmount;
  if (input.amount > refundable) throw new AppError(422, 'PAYMENT_EXCEEDS_BALANCE', `At most ${refundable} can still be refunded on this payment.`, { refundable });
  const doc = await docContext(tx, orgId, payment.branchId);

  // Refund the unapplied part first; only then take money back from bills (newest allocation first).
  let need = input.amount - Math.min(input.amount, payment.amount - payment.allocatedAmount - payment.refundedAmount);
  if (need > 0) {
    const allocations = await tx.selectFrom('paymentAllocations').select(['id', 'paymentId', 'invoiceId', 'amount']).where('paymentId', '=', payment.id).where('reversedAt', 'is', null).orderBy('createdAt', 'desc').orderBy('id', 'desc').forUpdate().execute();
    for (const a of allocations) {
      if (need <= 0) break;
      const take = Math.min(need, a.amount);
      await tx.selectFrom('invoices').select('id').where('id', '=', a.invoiceId).forUpdate().execute();
      await reverseAllocation(tx, a, `Refund: ${input.reason}`, auth.userId, a.amount - take);
      need -= take;
    }
  }
  const refundNumber = await nextAdjustmentNumber(tx, doc, 'refund');
  const refund = await tx
    .insertInto('refunds')
    .values({ organizationId: orgId, branchId: payment.branchId, customerId: payment.customerId, refundNumber, paymentId: payment.id, amount: input.amount, method: input.method, reference: input.reference ?? null, reason: input.reason, createdBy: auth.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  await tx.updateTable('payments').set((eb) => ({ refundedAmount: eb('refundedAmount', '+', input.amount) })).where('id', '=', payment.id).execute();
  await postLedger(tx, { orgId, branchId: payment.branchId, customerId: payment.customerId, entryType: 'refund', sourceType: 'refund', sourceId: refund.id, reference: refundNumber, description: `Refund: ${input.reason}`, debit: input.amount, by: auth.userId });
  await audit(tx, auth, { action: 'payment.refunded', entityType: 'payment', entityId: payment.id, branchId: payment.branchId, summary: `Refunded ${formatMoney(input.amount, doc.org.currency)} against ${payment.receiptNumber}: ${input.reason}`, after: { refundNumber, amount: input.amount, method: input.method } });
  return payment.id;
}

// ───────────── Adjustments / write-offs ─────────────
const ADJUSTMENT_ENTRY = { credit: 'credit_adjustment', write_off: 'write_off', discount: 'discount' } as const;
const ADJUSTMENT_LABEL = { credit: 'Adjustment', write_off: 'Written off', discount: 'Discount given' } as const;

export async function postAdjustment(tx: Tx, auth: AuthContext, input: AdjustIn): Promise<string> {
  const orgId = requireOrgId(auth);
  if (input.type === 'write_off' ? !hasPermission(auth, 'ledger.write_off') : !hasPermission(auth, 'ledger.adjust')) {
    throw new AppError(403, 'FORBIDDEN', input.type === 'write_off' ? "You don't have permission to write off amounts." : "You don't have permission to adjust bills.");
  }
  const peek = await tx.selectFrom('invoices').select(['customerId', 'branchId']).where('organizationId', '=', orgId).where('id', '=', input.invoiceId).executeTakeFirst();
  if (!peek) throw notFound('Bill');
  assertBranchAccess(auth, peek.branchId);
  await lockCustomerLedger(tx, peek.customerId);
  const invoice = await tx.selectFrom('invoices').selectAll().where('id', '=', input.invoiceId).forUpdate().executeTakeFirstOrThrow();
  if (invoice.status !== 'issued') throw new AppError(409, 'INVOICE_NOT_PAYABLE', 'This bill has been cancelled.');
  const doc = await docContext(tx, orgId, invoice.branchId);
  if (input.amount > invoice.balanceDue) throw new AppError(422, 'PAYMENT_EXCEEDS_BALANCE', `Only ${formatMoney(invoice.balanceDue, doc.org.currency)} is pending on this bill.`, { balanceDue: invoice.balanceDue });

  const adjustmentNumber = await nextAdjustmentNumber(tx, doc, 'adjustment');
  const row = await tx
    .insertInto('ledgerAdjustments')
    .values({ organizationId: orgId, branchId: invoice.branchId, customerId: invoice.customerId, adjustmentNumber, adjustmentType: input.type, invoiceId: invoice.id, amount: input.amount, reason: input.reason, createdBy: auth.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  const balanceDue = invoice.balanceDue - input.amount;
  const adjusted = invoice.amountAdjusted + input.amount;
  await tx
    .updateTable('invoices')
    .set({ amountAdjusted: adjusted, balanceDue, paymentStatus: settlementStatus(invoice.grandTotal, balanceDue, invoice.amountPaid + adjusted) })
    .where('id', '=', invoice.id)
    .execute();
  await postLedger(tx, { orgId, branchId: invoice.branchId, customerId: invoice.customerId, entryType: ADJUSTMENT_ENTRY[input.type], sourceType: 'adjustment', sourceId: row.id, reference: adjustmentNumber, description: `${ADJUSTMENT_LABEL[input.type]} on ${invoice.invoiceNumber}: ${input.reason}`, credit: input.amount, by: auth.userId });
  await audit(tx, auth, { action: `ledger.${input.type}`, entityType: 'invoice', entityId: invoice.id, branchId: invoice.branchId, summary: `${ADJUSTMENT_LABEL[input.type]} ${formatMoney(input.amount, doc.org.currency)} on ${invoice.invoiceNumber}: ${input.reason}`, before: { balanceDue: invoice.balanceDue }, after: { balanceDue, adjustmentNumber } });
  return invoice.id;
}

// ───────────── Read ─────────────
export async function loadPaymentDto(tx: Tx, auth: AuthContext, paymentId: string): Promise<PaymentDto> {
  const orgId = requireOrgId(auth);
  const p = await tx
    .selectFrom('payments as p')
    .innerJoin('branches as b', 'b.id', 'p.branchId')
    .innerJoin('customers as c', 'c.id', 'p.customerId')
    .innerJoin('users as u', 'u.id', 'p.receivedBy')
    .innerJoin('organizations as o', 'o.id', 'p.organizationId')
    .innerJoin('organizationSettings as s', 's.organizationId', 'p.organizationId')
    .selectAll('p')
    .select(['b.name as branchName', 'b.phone as branchPhone', 'b.addressLine1 as branchAddress', 'c.fullName as customerName', 'u.fullName as receivedByName', 'o.name as orgName', 'o.currency', 's.receiptFooter'])
    .where('p.organizationId', '=', orgId)
    .where('p.id', '=', paymentId)
    .executeTakeFirst();
  if (!p) throw notFound('Payment');
  assertBranchAccess(auth, p.branchId);
  const [allocations, refunds, balance] = await Promise.all([
    tx.selectFrom('paymentAllocations as pa').innerJoin('invoices as i', 'i.id', 'pa.invoiceId').select(['pa.invoiceId', 'i.invoiceNumber', 'pa.amount', 'pa.reversedAt']).where('pa.paymentId', '=', paymentId).orderBy('pa.createdAt').execute(),
    tx.selectFrom('refunds').select(['id', 'refundNumber', 'amount', 'method', 'reason', 'refundedAt']).where('paymentId', '=', paymentId).orderBy('refundedAt').execute(),
    customerBalance(tx, p.customerId),
  ]);
  return {
    id: p.id,
    receiptNumber: p.receiptNumber,
    receivedAt: p.receivedAt.toISOString(),
    branchId: p.branchId,
    branchName: p.branchName,
    customerId: p.customerId,
    customerName: p.customerName,
    method: p.method as PaymentDto['method'],
    amount: p.amount,
    allocatedAmount: p.allocatedAmount,
    refundedAmount: p.refundedAmount,
    unallocatedAmount: p.status === 'void' ? 0 : p.amount - p.allocatedAmount - p.refundedAmount,
    status: p.status as 'completed' | 'void',
    receivedByName: p.receivedByName,
    reference: p.reference,
    notes: p.notes,
    allocations: allocations.map((a) => ({ invoiceId: a.invoiceId, invoiceNumber: a.invoiceNumber, amount: a.amount, reversedAt: a.reversedAt?.toISOString() ?? null })),
    refunds: refunds.map((r) => ({ id: r.id, refundNumber: r.refundNumber, amount: r.amount, method: r.method as PaymentDto['method'], reason: r.reason, refundedAt: r.refundedAt.toISOString() })),
    customerBalanceAfter: balance,
    organization: { name: p.orgName, currency: p.currency, receiptFooter: p.receiptFooter },
    branch: { name: p.branchName, phone: p.branchPhone, address: p.branchAddress },
  };
}
