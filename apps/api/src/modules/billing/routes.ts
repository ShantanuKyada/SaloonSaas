import {
  adjustmentSchema,
  collectPaymentSchema,
  createInvoiceSchema,
  invoiceDraftSchema,
  invoiceListQuery,
  ledgerQuery,
  outstandingQuery,
  paymentListQuery,
  reasonSchema,
  refundSchema,
  type InvoiceSummary,
  type PaymentSummary,
} from '@salon/shared';
import { z } from 'zod';
import { branchFilter, requireOrgId } from '../../core/auth-context.js';
import { toCsv } from '../../core/csv.js';
import { localDateConditions } from '../../core/sql.js';
import { idempotent } from '../../core/idempotency.js';
import { createRouter, FileResponse, paged } from '../../core/router.js';
import { customerSearchCondition } from '../customers/service.js';
import { ledgerStatement, outstandingCustomers, outstandingInvoices, outstandingSummary, reconcile, sendOutstandingReminder } from '../collections/service.js';
import { collectPayment, loadPaymentDto, postAdjustment, refundPayment, voidPayment } from '../payments/service.js';
import { createInvoice, draftFromAppointment, loadInvoiceDto, voidInvoice } from './invoices.js';
import { previewFrom, resolveInvoice } from './resolve.js';

// ───────────── Bills ─────────────
const billing = createRouter('/billing', 'Billing');

billing.post('/preview', { summary: 'Price a bill without saving it (offers, discounts, tax, credit warnings)', permissions: ['billing.create'], body: invoiceDraftSchema, status: 200 }, async ({ tx, auth, body }) =>
  tx(async (t) => previewFrom(await resolveInvoice(t, auth, body, { strict: false, listOffers: true }))),
);

billing.get('/draft-from-appointment/:id', { summary: 'Pre-fill a bill from a finished appointment', permissions: ['billing.create'] }, async ({ tx, auth, params }) =>
  tx((t) => draftFromAppointment(t, auth, params.id!)),
);

billing.post(
  '/invoices',
  {
    summary: 'Create a bill (atomic: bill, lines, ledger, payments, packages, offer use)',
    description: 'Runs in one database transaction; any failure rolls everything back. Accepts an `Idempotency-Key` header so a double-click never creates two bills.',
    permissions: ['billing.create'],
    body: createInvoiceSchema,
    idempotent: true,
  },
  async ({ tx, auth, req, body }) =>
    tx((t) =>
      idempotent(t, auth, req, async () => {
        const id = await createInvoice(t, auth, body);
        return loadInvoiceDto(t, auth, id);
      }),
    ),
);

billing.get('/invoices', { summary: 'Bills (server-side pagination)', permissions: ['billing.view'], query: invoiceListQuery }, async ({ tx, auth, query }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    let base = t
      .selectFrom('invoices as i')
      .innerJoin('branches as b', 'b.id', 'i.branchId')
      .innerJoin('customers as c', 'c.id', 'i.customerId')
      .where('i.organizationId', '=', orgId)
      .where('i.branchId', 'in', branchFilter(auth, query.branchId));
    if (query.from) base = base.where('i.invoiceDate', '>=', query.from);
    if (query.to) base = base.where('i.invoiceDate', '<=', query.to);
    if (query.customerId) base = base.where('i.customerId', '=', query.customerId);
    if (query.paymentStatus.length) base = base.where('i.paymentStatus', 'in', query.paymentStatus);
    if (query.staffId) {
      const id = query.staffId;
      base = base.where((eb) => eb.exists(eb.selectFrom('invoiceItems as ii').select('ii.id').whereRef('ii.invoiceId', '=', 'i.id').where('ii.staffId', '=', id)));
    }
    if (query.search) {
      base = base.where((eb) => eb.or([eb('i.invoiceNumber', 'ilike', `%${query.search}%`), customerSearchCondition(query.search!)]));
    }
    const { n } = await base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    const rows = await base
      .select(['i.id', 'i.invoiceNumber', 'i.invoiceDate', 'b.name as branchName', 'c.fullName as customerName', 'i.customerId', 'i.grandTotal', 'i.amountPaid', 'i.amountAdjusted', 'i.balanceDue', 'i.paymentStatus', 'i.status'])
      .orderBy('i.issuedAt', 'desc')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .execute();
    return paged(rows as InvoiceSummary[], n, query.page, query.pageSize);
  }),
);

billing.get('/invoices/:id', { summary: 'Bill details (also used for the printable receipt)', permissions: ['billing.view'] }, async ({ tx, auth, params }) => tx((t) => loadInvoiceDto(t, auth, params.id!)));

billing.post('/invoices/:id/void', { summary: 'Cancel a bill (reverses ledger, packages and offer use; payments stay as advance)', permissions: ['billing.void'], body: reasonSchema, status: 200 }, async ({ tx, auth, params, body }) =>
  tx(async (t) => {
    await voidInvoice(t, auth, params.id!, body.reason);
    return loadInvoiceDto(t, auth, params.id!);
  }),
);

// ───────────── Payments ─────────────
const payments = createRouter('/payments', 'Payments & collections');

payments.post(
  '/collect',
  { summary: 'Collect a payment and apply it to pending bills (oldest first, or the bills you choose)', permissions: ['payments.collect'], body: collectPaymentSchema, idempotent: true },
  async ({ tx, auth, req, body }) =>
    tx((t) =>
      idempotent(t, auth, req, async () => {
        const id = await collectPayment(t, auth, body);
        return loadPaymentDto(t, auth, id);
      }),
    ),
);

payments.get('/', { summary: 'Payments received (server-side pagination)', permissions: ['billing.view', 'payments.collect'], query: paymentListQuery }, async ({ tx, auth, query }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    let base = t
      .selectFrom('payments as p')
      .innerJoin('branches as b', 'b.id', 'p.branchId')
      .innerJoin('customers as c', 'c.id', 'p.customerId')
      .innerJoin('users as u', 'u.id', 'p.receivedBy')
      .where('p.organizationId', '=', orgId)
      .where('p.branchId', 'in', branchFilter(auth, query.branchId));
    for (const cond of localDateConditions('p.received_at', 'b.timezone', query.from, query.to)) base = base.where(cond);
    if (query.customerId) base = base.where('p.customerId', '=', query.customerId);
    if (query.method.length) base = base.where('p.method', 'in', query.method);
    if (query.receivedBy) base = base.where('p.receivedBy', '=', query.receivedBy);
    if (query.search) base = base.where((eb) => eb.or([eb('p.receiptNumber', 'ilike', `%${query.search}%`), customerSearchCondition(query.search!)]));
    const { n } = await base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    const rows = await base
      .select(['p.id', 'p.receiptNumber', 'p.receivedAt', 'b.name as branchName', 'p.customerId', 'c.fullName as customerName', 'p.method', 'p.amount', 'p.allocatedAmount', 'p.refundedAmount', 'p.status', 'u.fullName as receivedByName', 'p.reference'])
      .orderBy('p.receivedAt', 'desc')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .execute();
    const items: PaymentSummary[] = rows.map((p) => ({
      id: p.id,
      receiptNumber: p.receiptNumber,
      receivedAt: p.receivedAt.toISOString(),
      branchName: p.branchName,
      customerId: p.customerId,
      customerName: p.customerName,
      method: p.method as PaymentSummary['method'],
      amount: p.amount,
      allocatedAmount: p.allocatedAmount,
      refundedAmount: p.refundedAmount,
      unallocatedAmount: p.status === 'void' ? 0 : p.amount - p.allocatedAmount - p.refundedAmount,
      status: p.status as 'completed' | 'void',
      receivedByName: p.receivedByName,
      reference: p.reference,
    }));
    return paged(items, n, query.page, query.pageSize);
  }),
);

payments.get('/:id', { summary: 'Payment / receipt details', permissions: ['billing.view', 'payments.collect'] }, async ({ tx, auth, params }) => tx((t) => loadPaymentDto(t, auth, params.id!)));

payments.post('/:id/void', { summary: 'Cancel a payment (its bills become pending again)', permissions: ['payments.void'], body: reasonSchema, status: 200 }, async ({ tx, auth, params, body }) =>
  tx(async (t) => {
    await voidPayment(t, auth, params.id!, body.reason);
    return loadPaymentDto(t, auth, params.id!);
  }),
);

payments.post('/refund', { summary: 'Refund money to a customer', permissions: ['payments.refund'], body: refundSchema, idempotent: true }, async ({ tx, auth, req, body }) =>
  tx((t) =>
    idempotent(t, auth, req, async () => {
      const id = await refundPayment(t, auth, body);
      return loadPaymentDto(t, auth, id);
    }),
  ),
);

// ───────────── Ledger ─────────────
const ledger = createRouter('/ledger', 'Pending payments & ledger');

ledger.get('/', { summary: 'Customer ledger statement with running balance', permissions: ['ledger.view'], query: ledgerQuery }, async ({ tx, auth, query }) => tx((t) => ledgerStatement(t, auth, query)));

ledger.get('/export', { summary: 'Customer ledger as CSV', permissions: ['ledger.view'], query: ledgerQuery }, async ({ tx, auth, query }) =>
  tx(async (t) => {
    const s = await ledgerStatement(t, auth, query);
    const rows = [['', 'Opening balance', '', '', '', s.openingBalance / 100], ...s.rows.map((r) => [r.occurredAt.slice(0, 10), r.reference, r.description, r.debit / 100 || '', r.credit / 100 || '', r.balance / 100])];
    return new FileResponse(`ledger-${s.customer.customerCode}.csv`, 'text/csv; charset=utf-8', toCsv(['Date', 'Reference', 'Description', 'Debit', 'Credit', 'Balance'], rows));
  }),
);

ledger.post('/adjustments', { summary: 'Adjust, discount or write off part of a pending bill (reason required, audited)', permissions: ['ledger.adjust', 'ledger.write_off'], body: adjustmentSchema }, async ({ tx, auth, body }) =>
  tx(async (t) => {
    const id = await postAdjustment(t, auth, body);
    return loadInvoiceDto(t, auth, id);
  }),
);

ledger.get('/reconcile', { summary: 'Self-check: ledger, cached balances, bills and payments must agree', permissions: ['reports.financial'] }, async ({ tx, auth }) => tx((t) => reconcile(t, requireOrgId(auth))));

// ───────────── Pending payments (outstanding) ─────────────
const outstanding = createRouter('/outstanding', 'Pending payments & ledger');
const reportPerms = ['ledger.view', 'reports.financial'] as const;

outstanding.get('/summary', { summary: 'Total pending, overdue, ageing buckets and branch-wise split', permissions: [...reportPerms], query: outstandingQuery.pick({ branchId: true, asOf: true }) }, async ({ tx, auth, query }) =>
  tx((t) => outstandingSummary(t, auth, query)),
);

outstanding.get('/customers', { summary: 'Customer-wise pending payments with ageing', permissions: [...reportPerms], query: outstandingQuery }, async ({ tx, auth, query }) =>
  tx(async (t) => {
    const { items, total } = await outstandingCustomers(t, auth, query, query);
    return paged(items, total, query.page, query.pageSize);
  }),
);

outstanding.get('/invoices', { summary: 'Bill-wise pending payments', permissions: [...reportPerms], query: outstandingQuery.extend({ customerId: z.uuid().optional() }) }, async ({ tx, auth, query }) =>
  tx(async (t) => {
    const { items, total } = await outstandingInvoices(t, auth, query, query);
    return paged(items, total, query.page, query.pageSize);
  }),
);

outstanding.post('/remind', { summary: 'Send a pending-payment reminder (rate-limited, respects opt-outs)', permissions: ['payments.collect', 'ledger.view'], body: z.object({ customerId: z.uuid() }), status: 200 }, async ({ tx, auth, body }) =>
  tx((t) => sendOutstandingReminder(t, auth, body.customerId, 'manual')),
);

export const billingRoutes = billing;
export const paymentRoutes = payments;
export const ledgerRoutes = ledger;
export const outstandingRoutes = outstanding;
