import { formatMoney, PAYMENT_METHOD_LABELS, type LedgerEntryType, type PaymentMethod } from '@salon/shared';
import { DateTime } from 'luxon';
import type { AuthContext } from '../../core/auth-context.js';
import { AppError } from '../../core/errors.js';
import { financialPeriodKey, localDateOf } from '../../core/time.js';
import { nextBranchDocumentNumber } from '../../core/sequences.js';
import type { BranchRow, OrgContext, OrgSettings } from '../../core/validation.js';
import { advisoryLock, type Tx } from '../../db/tenant.js';
import { enqueueNotification } from '../notifications/outbox.js';

// Every money movement funnels through these helpers so the ledger, invoice settlement columns and payment
// allocation columns are always updated together, inside the caller's transaction.

/** Serialises all money changes for one customer (credit-limit checks and allocations must not interleave). */
export async function lockCustomerLedger(tx: Tx, customerId: string): Promise<void> {
  await advisoryLock(tx, 'customer-ledger', customerId);
}

export interface LedgerPost {
  orgId: string;
  branchId: string;
  customerId: string;
  entryType: LedgerEntryType;
  sourceType: 'invoice' | 'payment' | 'refund' | 'adjustment';
  sourceId: string;
  reference: string;
  description: string;
  debit?: number;
  credit?: number;
  by: string | null;
}

export async function postLedger(tx: Tx, e: LedgerPost): Promise<void> {
  const debit = e.debit ?? 0;
  const credit = e.credit ?? 0;
  if ((debit > 0) === (credit > 0)) throw new AppError(500, 'FINANCIAL_INTEGRITY', 'A ledger entry needs exactly one of debit or credit.');
  await tx
    .insertInto('ledgerEntries')
    .values({
      organizationId: e.orgId,
      branchId: e.branchId,
      customerId: e.customerId,
      entryType: e.entryType,
      sourceType: e.sourceType,
      sourceId: e.sourceId,
      reference: e.reference,
      description: e.description,
      debit,
      credit,
      createdBy: e.by,
    })
    .execute();
}

export function settlementStatus(grandTotal: number, balanceDue: number, settled: number): 'unpaid' | 'partial' | 'paid' {
  if (balanceDue === 0) return 'paid';
  if (settled === 0 && balanceDue === grandTotal) return 'unpaid';
  return 'partial';
}

export async function customerBalance(tx: Tx, customerId: string): Promise<number> {
  const row = await tx.selectFrom('customerAccounts').select('balance').where('customerId', '=', customerId).executeTakeFirst();
  return row?.balance ?? 0;
}

export interface DocContext {
  org: OrgContext;
  branch: BranchRow;
  settings: OrgSettings;
}

export function periodKey(org: OrgContext, branch: BranchRow, at = new Date()): string {
  return financialPeriodKey(localDateOf(at, branch.timezone), org.country);
}

export async function nextInvoiceNumber(tx: Tx, c: DocContext): Promise<string> {
  return nextBranchDocumentNumber(tx, { organizationId: c.org.id, branchId: c.branch.id, branchCode: c.branch.code, docType: 'invoice', prefix: c.settings.invoicePrefix, periodKey: periodKey(c.org, c.branch) });
}

export async function nextReceiptNumber(tx: Tx, c: DocContext): Promise<string> {
  return nextBranchDocumentNumber(tx, { organizationId: c.org.id, branchId: c.branch.id, branchCode: c.branch.code, docType: 'receipt', prefix: c.settings.receiptPrefix, periodKey: periodKey(c.org, c.branch) });
}

export async function nextAdjustmentNumber(tx: Tx, c: DocContext, kind: 'refund' | 'adjustment'): Promise<string> {
  return nextBranchDocumentNumber(tx, { organizationId: c.org.id, branchId: c.branch.id, branchCode: c.branch.code, docType: kind, prefix: kind === 'refund' ? 'RFD' : 'ADJ', periodKey: periodKey(c.org, c.branch) });
}

// ───────────── Payments and allocations ─────────────

export async function insertPayment(
  tx: Tx,
  auth: AuthContext,
  c: DocContext,
  args: { customerId: string; amount: number; method: PaymentMethod; reference?: string | null; notes?: string | null },
) {
  const receiptNumber = await nextReceiptNumber(tx, c);
  const payment = await tx
    .insertInto('payments')
    .values({
      organizationId: c.org.id,
      branchId: c.branch.id,
      customerId: args.customerId,
      receiptNumber,
      amount: args.amount,
      method: args.method,
      reference: args.reference ?? null,
      notes: args.notes ?? null,
      receivedBy: auth.userId,
    })
    .returning(['id', 'receiptNumber', 'amount', 'receivedAt'])
    .executeTakeFirstOrThrow();
  await postLedger(tx, {
    orgId: c.org.id,
    branchId: c.branch.id,
    customerId: args.customerId,
    entryType: 'payment',
    sourceType: 'payment',
    sourceId: payment.id,
    reference: receiptNumber,
    description: `Payment received (${PAYMENT_METHOD_LABELS[args.method]})`,
    credit: args.amount,
    by: auth.userId,
  });
  return { ...payment, method: args.method };
}

/** Applies part of a payment to an invoice. The caller must hold FOR UPDATE locks on both rows. */
export async function allocatePayment(
  tx: Tx,
  args: { orgId: string; paymentId: string; invoiceId: string; amount: number; by: string | null },
): Promise<void> {
  if (args.amount <= 0) return;
  const invoice = await tx.selectFrom('invoices').select(['grandTotal', 'amountPaid', 'amountAdjusted', 'balanceDue', 'status']).where('id', '=', args.invoiceId).executeTakeFirstOrThrow();
  if (invoice.status !== 'issued') throw new AppError(409, 'INVOICE_NOT_PAYABLE', 'This bill has been cancelled and cannot take payments.');
  if (args.amount > invoice.balanceDue) throw new AppError(422, 'PAYMENT_EXCEEDS_BALANCE', 'That amount is more than what is pending on this bill.', { balanceDue: invoice.balanceDue });
  const payment = await tx.selectFrom('payments').select(['amount', 'allocatedAmount', 'refundedAmount', 'status']).where('id', '=', args.paymentId).executeTakeFirstOrThrow();
  if (payment.status !== 'completed') throw new AppError(409, 'CONFLICT', 'This payment has been cancelled.');
  if (args.amount > payment.amount - payment.allocatedAmount - payment.refundedAmount) throw new AppError(422, 'PAYMENT_EXCEEDS_BALANCE', 'That is more than this payment has left to apply.');

  await tx.insertInto('paymentAllocations').values({ organizationId: args.orgId, paymentId: args.paymentId, invoiceId: args.invoiceId, amount: args.amount, createdBy: args.by }).execute();
  const balanceDue = invoice.balanceDue - args.amount;
  const settled = invoice.amountPaid + args.amount + invoice.amountAdjusted;
  await tx
    .updateTable('invoices')
    .set({ amountPaid: invoice.amountPaid + args.amount, balanceDue, paymentStatus: settlementStatus(invoice.grandTotal, balanceDue, settled) })
    .where('id', '=', args.invoiceId)
    .execute();
  await tx.updateTable('payments').set({ allocatedAmount: payment.allocatedAmount + args.amount }).where('id', '=', args.paymentId).execute();
}

/** Reverses one allocation (payment void, invoice void or a refund that needs the money back). */
export async function reverseAllocation(
  tx: Tx,
  allocation: { id: string; paymentId: string; invoiceId: string; amount: number },
  reason: string,
  by: string | null,
  keepAmount = 0,
): Promise<void> {
  const reverse = allocation.amount - keepAmount;
  await tx.updateTable('paymentAllocations').set({ reversedAt: new Date(), reversedBy: by, reversalReason: reason }).where('id', '=', allocation.id).execute();
  if (keepAmount > 0) {
    const original = await tx.selectFrom('paymentAllocations').select('organizationId').where('id', '=', allocation.id).executeTakeFirstOrThrow();
    await tx.insertInto('paymentAllocations').values({ organizationId: original.organizationId, paymentId: allocation.paymentId, invoiceId: allocation.invoiceId, amount: keepAmount, createdBy: by }).execute();
  }
  const invoice = await tx.selectFrom('invoices').select(['grandTotal', 'amountPaid', 'amountAdjusted', 'balanceDue', 'status']).where('id', '=', allocation.invoiceId).executeTakeFirstOrThrow();
  if (invoice.status === 'issued') {
    const balanceDue = invoice.balanceDue + reverse;
    const paid = invoice.amountPaid - reverse;
    await tx
      .updateTable('invoices')
      .set({ amountPaid: paid, balanceDue, paymentStatus: settlementStatus(invoice.grandTotal, balanceDue, paid + invoice.amountAdjusted) })
      .where('id', '=', allocation.invoiceId)
      .execute();
  }
  const payment = await tx.selectFrom('payments').select('allocatedAmount').where('id', '=', allocation.paymentId).executeTakeFirstOrThrow();
  await tx.updateTable('payments').set({ allocatedAmount: payment.allocatedAmount - reverse }).where('id', '=', allocation.paymentId).execute();
}

/** Queues the receipt message (WhatsApp/email per customer preference). Never throws into the money transaction. */
export async function queueReceipt(tx: Tx, auth: AuthContext, c: DocContext, payment: { id: string; receiptNumber: string; amount: number; method: PaymentMethod; receivedAt: Date }, customerId: string): Promise<void> {
  const balance = await customerBalance(tx, customerId);
  await enqueueNotification(tx, {
    orgId: c.org.id,
    branchId: c.branch.id,
    customerId,
    eventType: 'payment_receipt',
    sourceType: 'payment',
    sourceId: payment.id,
    dedupeKey: `payment:${payment.id}:receipt`,
    createdBy: auth.userId,
    variables: {
      salonName: c.org.name,
      branchName: c.branch.name,
      amount: formatMoney(payment.amount, c.org.currency),
      receiptNumber: payment.receiptNumber,
      method: PAYMENT_METHOD_LABELS[payment.method],
      date: DateTime.fromJSDate(payment.receivedAt).setZone(c.branch.timezone).toFormat('d LLL yyyy'),
      balance: formatMoney(Math.max(balance, 0), c.org.currency),
    },
  });
}
