import {
  customerListQuery,
  customerPreferencesSchema,
  customerSchema,
  customerUpdateSchema,
  quickCustomerSchema,
  segmentFilterSchema,
  segmentSchema,
  type Customer360,
  type CustomerListItem,
  type CustomerSearchResult,
} from '@salon/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import { audit } from '../../core/audit.js';
import { hasPermission, nonEmpty, requireOrgId } from '../../core/auth-context.js';
import type { Tx } from '../../db/tenant.js';
import { AppError, notFound } from '../../core/errors.js';
import { createRouter, FileResponse, paged } from '../../core/router.js';
import { loadOrg, loadSettings, optionalPhone } from '../../core/validation.js';
import {
  canSeeContact,
  createCustomerRecord,
  customerSearchCondition,
  loadCustomerDetail,
  maskContact,
  savePreferences,
  segmentQuery,
} from './service.js';
import { toCsv } from '../../core/csv.js';

const r = createRouter('/customers', 'Customers');

const ACTIVE_STATUSES = ['scheduled', 'confirmed', 'checked_in', 'in_service'];

r.get(
  '/search',
  {
    summary: 'Find a customer by name, mobile number, customer code or email',
    description: 'Built for the always-visible search box: returns the few facts a receptionist needs at a glance.',
    permissions: ['customers.view'],
    query: z.object({ q: z.string().trim().min(1).max(60) }),
  },
  async ({ tx, auth, query }) =>
    tx(async (t) => {
      const orgId = requireOrgId(auth);
      const settings = await loadSettings(t, orgId);
      const branches = nonEmpty(auth.branchIds);
      const rows = await t
        .selectFrom('customers as c')
        .leftJoin('customerStats as cs', 'cs.customerId', 'c.id')
        .leftJoin('customerAccounts as ca', 'ca.customerId', 'c.id')
        .leftJoin('services as fs', 'fs.id', 'cs.favoriteServiceId')
        .leftJoin('staff as fst', 'fst.id', 'cs.favoriteStaffId')
        .select([
          'c.id',
          'c.customerCode',
          'c.fullName',
          'c.mobile',
          'c.email',
          'cs.lastVisitAt',
          'fs.name as favoriteService',
          'fst.id as favoriteStaffId',
          'fst.displayName as favoriteStaffName',
          sql<number>`greatest(coalesce(ca.balance, 0), 0)`.as('outstanding'),
        ])
        .select(
          sql<string | null>`(
            select a.id::text || '|' || a.start_at::text || '|' || b.name || '|' ||
                   coalesce((select string_agg(s.name, ', ' order by ai.sort_order) from appointment_items ai join services s on s.id = ai.service_id where ai.appointment_id = a.id), '')
              from appointments a join branches b on b.id = a.branch_id
             where a.customer_id = c.id and a.status in ('scheduled','confirmed','checked_in','in_service')
               and a.start_at >= now() - interval '2 hours' and a.branch_id = any(${branches}::uuid[])
             order by a.start_at limit 1)`.as('upcoming'),
        )
        .where('c.organizationId', '=', orgId)
        .where('c.status', '!=', 'archived')
        .where(customerSearchCondition(query.q))
        .orderBy(sql`(c.mobile = ${query.q.replace(/\D/g, '')} or c.customer_code ilike ${query.q}) desc`)
        .orderBy('cs.lastVisitAt', (o) => o.desc().nullsLast())
        .orderBy('c.fullName')
        .limit(8)
        .execute();
      const visible = canSeeContact(auth, settings);
      return rows.map((c): CustomerSearchResult => {
        const [apptId, startAt, branchName, services] = (c.upcoming ?? '').split('|');
        const base = maskContact({ mobile: c.mobile, email: c.email }, visible);
        return {
          id: c.id,
          customerCode: c.customerCode,
          fullName: c.fullName,
          mobile: base.mobile,
          email: base.email,
          lastVisitAt: c.lastVisitAt?.toISOString() ?? null,
          favoriteService: c.favoriteService,
          favoriteStaff: c.favoriteStaffId ? { id: c.favoriteStaffId, name: c.favoriteStaffName! } : null,
          outstanding: Number(c.outstanding),
          upcomingAppointment: apptId ? { id: apptId, startAt: new Date(startAt!).toISOString(), branchName: branchName!, services: services ?? '' } : null,
        };
      });
    }),
);

function listBase(t: Tx, orgId: string, query: z.output<typeof customerListQuery>) {
  let q = t
    .selectFrom('customers as c')
    .leftJoin('customerStats as cs', 'cs.customerId', 'c.id')
    .leftJoin('customerAccounts as ca', 'ca.customerId', 'c.id')
    .where('c.organizationId', '=', orgId);
  if (query.status !== 'all') q = q.where('c.status', '=', query.status);
  else q = q.where('c.status', '!=', 'archived');
  if (query.search) q = q.where(customerSearchCondition(query.search));
  if (query.tag) q = q.where(sql<boolean>`${query.tag} = any(c.tags)`);
  if (query.hasOutstanding) q = q.where(sql<boolean>`coalesce(ca.balance, 0) > 0`);
  if (query.branchId) {
    const branchId = query.branchId;
    q = q.where(sql<boolean>`coalesce(cs.last_branch_id, c.preferred_branch_id, c.registered_branch_id) = ${branchId}`);
  }
  return q;
}
const SORTS: Record<string, string> = {
  name: 'c.full_name',
  lastVisit: 'cs.last_visit_at',
  spend: 'cs.lifetime_spend',
  outstanding: 'ca.balance',
  registered: 'c.registered_at',
};

r.get('/', { summary: 'Customer list (server-side pagination)', permissions: ['customers.view'], query: customerListQuery }, async ({ tx, auth, query }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const settings = await loadSettings(t, orgId);
    const base = listBase(t, orgId, query);
    const { n } = await base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    const sortCol = SORTS[query.sortBy ?? 'registered'] ?? SORTS.registered!;
    const dir = query.sortDir === 'asc' ? sql`asc nulls last` : sql`desc nulls last`;
    const rows = await base
      .select([
        'c.id',
        'c.customerCode',
        'c.fullName',
        'c.mobile',
        'c.email',
        'c.gender',
        'c.status',
        'c.tags',
        'c.registeredAt',
        'c.marketingConsent',
        'cs.lastVisitAt',
        sql<number>`coalesce(cs.visit_count, 0)`.as('visitCount'),
        sql<number>`coalesce(cs.lifetime_spend, 0)`.as('lifetimeSpend'),
        sql<number>`greatest(coalesce(ca.balance, 0), 0)`.as('outstanding'),
      ])
      .orderBy(sql`${sql.raw(sortCol)} ${dir}`)
      .orderBy('c.id')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .execute();
    const visible = canSeeContact(auth, settings);
    const items = rows.map((c): CustomerListItem =>
      maskContact(
        {
          id: c.id,
          customerCode: c.customerCode,
          fullName: c.fullName,
          mobile: c.mobile,
          email: c.email,
          gender: c.gender as CustomerListItem['gender'],
          status: c.status,
          tags: c.tags,
          registeredAt: c.registeredAt.toISOString(),
          lastVisitAt: c.lastVisitAt?.toISOString() ?? null,
          visitCount: Number(c.visitCount),
          lifetimeSpend: Number(c.lifetimeSpend),
          outstanding: Number(c.outstanding),
          marketingConsent: c.marketingConsent,
        },
        visible,
      ),
    );
    return paged(items, n, query.page, query.pageSize);
  }),
);

r.get('/export', { summary: 'Export customers as CSV', permissions: ['customers.export'], query: customerListQuery }, async ({ tx, auth, query }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const rows = await listBase(t, orgId, query)
      .select(['c.customerCode', 'c.fullName', 'c.mobile', 'c.email', 'c.gender', 'c.city', 'c.registeredAt', 'c.marketingConsent', 'cs.lastVisitAt', sql<number>`coalesce(cs.visit_count, 0)`.as('visits'), sql<number>`coalesce(cs.lifetime_spend, 0) / 100.0`.as('spend'), sql<number>`greatest(coalesce(ca.balance, 0), 0) / 100.0`.as('outstanding')])
      .orderBy('c.fullName')
      .limit(50000)
      .execute();
    await audit(t, auth, { action: 'customer.exported', entityType: 'customer', summary: `Exported ${rows.length} customers` });
    return new FileResponse(
      'customers.csv',
      'text/csv; charset=utf-8',
      toCsv(
        ['Customer code', 'Name', 'Mobile', 'Email', 'Gender', 'City', 'Registered', 'Marketing consent', 'Last visit', 'Visits', 'Lifetime spend', 'Pending payment'],
        rows.map((c) => [c.customerCode, c.fullName, c.mobile, c.email, c.gender, c.city, c.registeredAt.toISOString().slice(0, 10), c.marketingConsent ? 'Yes' : 'No', c.lastVisitAt?.toISOString().slice(0, 10) ?? '', c.visits, c.spend, c.outstanding]),
      ),
    );
  }),
);

r.get('/:id', { summary: 'Customer profile', permissions: ['customers.view'] }, async ({ tx, auth, params }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    return loadCustomerDetail(t, auth, orgId, params.id!, await loadSettings(t, orgId));
  }),
);

r.get('/:id/360', { summary: 'Customer 360° view: history, spend, pending payments, packages, messages', permissions: ['customers.view'] }, async ({ tx, auth, params }) =>
  tx(async (t): Promise<Customer360> => {
    const orgId = requireOrgId(auth);
    const settings = await loadSettings(t, orgId);
    const org = await loadOrg(t, orgId);
    const customer = await loadCustomerDetail(t, auth, orgId, params.id!, settings);
    const id = customer.id;
    const branches = nonEmpty(auth.branchIds);
    const seeMoney = hasPermission(auth, 'ledger.view') || hasPermission(auth, 'billing.view');

    const stats = await t
      .selectFrom('customerStats as cs')
      .leftJoin('services as fs', 'fs.id', 'cs.favoriteServiceId')
      .leftJoin('staff as fst', 'fst.id', 'cs.favoriteStaffId')
      .select(['cs.visitCount', 'cs.lifetimeSpend', 'cs.firstVisitAt', 'cs.lastVisitAt', 'cs.cancelledCount', 'cs.noShowCount', 'cs.favoriteServiceId', 'fs.name as favoriteServiceName', 'cs.favoriteStaffId', 'fst.displayName as favoriteStaffName'])
      .where('cs.customerId', '=', id)
      .executeTakeFirst();

    const apptSummary = (statusFilter: 'upcoming' | 'recent') => {
      let q = t
        .selectFrom('appointments as a')
        .innerJoin('branches as b', 'b.id', 'a.branchId')
        .select([
          'a.id',
          'a.bookingNumber',
          'a.status',
          'a.startAt',
          'a.estimatedAmount',
          'b.name as branchName',
          sql<string>`coalesce((select string_agg(s.name, ', ' order by ai.sort_order) from appointment_items ai join services s on s.id = ai.service_id where ai.appointment_id = a.id), '')`.as('services'),
          sql<string>`coalesce((select string_agg(distinct st.display_name, ', ') from appointment_items ai join staff st on st.id = ai.staff_id where ai.appointment_id = a.id), '')`.as('staff'),
        ])
        .where('a.organizationId', '=', orgId)
        .where('a.customerId', '=', id)
        .where('a.branchId', 'in', branches);
      q = statusFilter === 'upcoming'
        ? q.where('a.status', 'in', ACTIVE_STATUSES).where('a.startAt', '>=', sql<Date>`now() - interval '2 hours'`).orderBy('a.startAt').limit(5)
        : q.where('a.startAt', '<', sql<Date>`now()`).orderBy('a.startAt', 'desc').limit(10);
      return q.execute();
    };

    const [upcoming, recent] = await Promise.all([apptSummary('upcoming'), apptSummary('recent')]);
    const toSummary = (a: (typeof upcoming)[number]) => ({
      id: a.id,
      bookingNumber: a.bookingNumber,
      status: a.status as Customer360['recentAppointments'][number]['status'],
      startAt: a.startAt?.toISOString() ?? null,
      branchName: a.branchName,
      services: a.services,
      staff: a.staff,
      amount: a.estimatedAmount,
    });

    let account: Customer360['account'] = { balance: 0, outstanding: 0, advance: 0, creditLimit: customer.creditLimit, availableCredit: null, otherBranchesOutstanding: 0 };
    let invoices: Customer360['invoices'] = [];
    let payments: Customer360['payments'] = [];
    let topServices: Customer360['topServices'] = [];
    let staffUsed: Customer360['staffUsed'] = [];
    let packages: Customer360['packages'] = [];
    let offersUsed: Customer360['offersUsed'] = [];

    if (seeMoney) {
      const acct = await t.selectFrom('customerAccounts').select('balance').where('customerId', '=', id).executeTakeFirst();
      const balance = acct?.balance ?? 0;
      const visibleNet = await t
        .selectFrom('ledgerEntries')
        .select(sql<number>`coalesce(sum(debit - credit), 0)`.as('net'))
        .where('organizationId', '=', orgId)
        .where('customerId', '=', id)
        .where('branchId', 'in', branches)
        .executeTakeFirstOrThrow();
      const outstanding = Math.max(balance, 0);
      account = {
        balance,
        outstanding,
        advance: Math.max(-balance, 0),
        creditLimit: customer.creditLimit,
        availableCredit: customer.creditLimit === null ? null : Math.max(customer.creditLimit - outstanding, 0),
        otherBranchesOutstanding: auth.allBranches ? 0 : Math.max(balance - Number(visibleNet.net), 0),
      };

      invoices = (
        await t
          .selectFrom('invoices as i')
          .innerJoin('branches as b', 'b.id', 'i.branchId')
          .select(['i.id', 'i.invoiceNumber', 'i.invoiceDate', 'b.name as branchName', 'i.grandTotal', 'i.amountPaid', 'i.amountAdjusted', 'i.balanceDue', 'i.paymentStatus', 'i.status'])
          .where('i.organizationId', '=', orgId)
          .where('i.customerId', '=', id)
          .where('i.branchId', 'in', branches)
          .orderBy('i.issuedAt', 'desc')
          .limit(10)
          .execute()
      ).map((i) => ({ ...i, customerId: id, customerName: customer.fullName, paymentStatus: i.paymentStatus as Customer360['invoices'][number]['paymentStatus'], status: i.status as 'issued' | 'void' }));

      payments = (
        await t
          .selectFrom('payments as p')
          .innerJoin('branches as b', 'b.id', 'p.branchId')
          .innerJoin('users as u', 'u.id', 'p.receivedBy')
          .select(['p.id', 'p.receiptNumber', 'p.receivedAt', 'b.name as branchName', 'p.method', 'p.amount', 'p.allocatedAmount', 'p.refundedAmount', 'p.status', 'u.fullName as receivedByName', 'p.reference'])
          .where('p.organizationId', '=', orgId)
          .where('p.customerId', '=', id)
          .where('p.branchId', 'in', branches)
          .orderBy('p.receivedAt', 'desc')
          .limit(10)
          .execute()
      ).map((p) => ({
        id: p.id,
        receiptNumber: p.receiptNumber,
        receivedAt: p.receivedAt.toISOString(),
        branchName: p.branchName,
        customerId: id,
        customerName: customer.fullName,
        method: p.method as Customer360['payments'][number]['method'],
        amount: p.amount,
        allocatedAmount: p.allocatedAmount,
        refundedAmount: p.refundedAmount,
        unallocatedAmount: p.status === 'void' ? 0 : p.amount - p.allocatedAmount - p.refundedAmount,
        status: p.status as 'completed' | 'void',
        receivedByName: p.receivedByName,
        reference: p.reference,
      }));

      topServices = (
        await t
          .selectFrom('invoiceItems as ii')
          .innerJoin('invoices as i', 'i.id', 'ii.invoiceId')
          .innerJoin('services as s', 's.id', 'ii.serviceId')
          .select(['s.id as serviceId', 's.name', sql<number>`sum(ii.quantity)`.as('count'), sql<number>`sum(ii.line_total)`.as('spend')])
          .where('i.organizationId', '=', orgId)
          .where('i.customerId', '=', id)
          .where('i.status', '=', 'issued')
          .where('i.branchId', 'in', branches)
          .groupBy(['s.id', 's.name'])
          .orderBy(sql`sum(ii.quantity)`, 'desc')
          .limit(5)
          .execute()
      ).map((s) => ({ ...s, count: Number(s.count), spend: Number(s.spend) }));

      staffUsed = (
        await t
          .selectFrom('invoiceItems as ii')
          .innerJoin('invoices as i', 'i.id', 'ii.invoiceId')
          .innerJoin('staff as st', 'st.id', 'ii.staffId')
          .select(['st.id as staffId', 'st.displayName as name', sql<number>`count(*)`.as('count'), sql<Date>`max(i.issued_at)`.as('lastAt')])
          .where('i.organizationId', '=', orgId)
          .where('i.customerId', '=', id)
          .where('i.status', '=', 'issued')
          .where('i.branchId', 'in', branches)
          .groupBy(['st.id', 'st.displayName'])
          .orderBy(sql`count(*)`, 'desc')
          .limit(5)
          .execute()
      ).map((s) => ({ staffId: s.staffId, name: s.name, count: Number(s.count), lastAt: new Date(s.lastAt).toISOString() }));

      const pkgs = await t
        .selectFrom('customerPackages as cp')
        .innerJoin('packages as p', 'p.id', 'cp.packageId')
        .select(['cp.id', 'cp.packageId', 'p.name as packageName', 'cp.purchasedAt', 'cp.expiresAt', 'cp.status', 'cp.pricePaid'])
        .where('cp.organizationId', '=', orgId)
        .where('cp.customerId', '=', id)
        .orderBy('cp.purchasedAt', 'desc')
        .limit(10)
        .execute();
      const pkgItems = pkgs.length
        ? await t
            .selectFrom('customerPackageItems as cpi')
            .innerJoin('services as s', 's.id', 'cpi.serviceId')
            .select(['cpi.id', 'cpi.customerPackageId', 'cpi.serviceId', 's.name as serviceName', 'cpi.quantityTotal', 'cpi.quantityUsed'])
            .where('cpi.customerPackageId', 'in', pkgs.map((p) => p.id))
            .execute()
        : [];
      packages = pkgs.map((p) => ({
        id: p.id,
        packageId: p.packageId,
        packageName: p.packageName,
        purchasedAt: p.purchasedAt.toISOString(),
        expiresAt: p.expiresAt.toISOString(),
        status: p.status,
        pricePaid: p.pricePaid,
        items: pkgItems.filter((i) => i.customerPackageId === p.id).map((i) => ({ id: i.id, serviceId: i.serviceId, serviceName: i.serviceName, quantityTotal: i.quantityTotal, quantityUsed: i.quantityUsed, remaining: i.quantityTotal - i.quantityUsed })),
      }));

      offersUsed = (
        await t
          .selectFrom('offerRedemptions as r')
          .innerJoin('offers as o', 'o.id', 'r.offerId')
          .innerJoin('invoices as i', 'i.id', 'r.invoiceId')
          .select(['o.id as offerId', 'o.name', 'r.discountAmount as discount', 'i.invoiceNumber', 'r.redeemedAt'])
          .where('r.organizationId', '=', orgId)
          .where('r.customerId', '=', id)
          .where('r.reversedAt', 'is', null)
          .where('i.branchId', 'in', branches)
          .orderBy('r.redeemedAt', 'desc')
          .limit(10)
          .execute()
      ).map((o) => ({ ...o, redeemedAt: o.redeemedAt.toISOString() }));
    }

    const communications = (
      await t
        .selectFrom('notifications')
        .select(['id', 'createdAt', 'eventType', 'category', 'channel', 'recipient', 'status', 'statusReason', 'attempts', 'scheduledFor', 'sentAt', 'deliveredAt', 'readAt', 'lastError', 'body'])
        .where('organizationId', '=', orgId)
        .where('customerId', '=', id)
        .orderBy('createdAt', 'desc')
        .limit(15)
        .execute()
    ).map((n) => ({
      id: n.id,
      createdAt: n.createdAt.toISOString(),
      eventType: n.eventType,
      category: n.category as Customer360['communications'][number]['category'],
      channel: n.channel as Customer360['communications'][number]['channel'],
      recipient: canSeeContact(auth, settings) ? n.recipient : '••••••',
      customerId: id,
      customerName: customer.fullName,
      status: n.status as Customer360['communications'][number]['status'],
      statusReason: n.statusReason,
      attempts: n.attempts,
      scheduledFor: n.scheduledFor.toISOString(),
      sentAt: n.sentAt?.toISOString() ?? null,
      deliveredAt: n.deliveredAt?.toISOString() ?? null,
      readAt: n.readAt?.toISOString() ?? null,
      lastError: n.lastError,
      body: n.body,
    }));

    // "Usually books Hair Spa with Rahul on Saturday evening" — surfaced so the receptionist does not start from scratch.
    const habit = await sql<{ weekday: number; hour: number; n: number }>`
      select extract(isodow from a.start_at at time zone ${org.timezone})::int as weekday,
             extract(hour from a.start_at at time zone ${org.timezone})::int as hour, count(*)::int as n
        from appointments a
       where a.organization_id = ${orgId} and a.customer_id = ${id} and a.status in ('completed','scheduled','confirmed') and a.start_at is not null
       group by 1, 2 order by n desc, max(a.start_at) desc limit 1`.execute(t);
    const visits = stats?.visitCount ?? 0;
    const spend = stats?.lifetimeSpend ?? 0;
    const monthsActive = stats?.firstVisitAt ? Math.max((Date.now() - stats.firstVisitAt.getTime()) / (30.44 * 86400_000), 1) : null;

    return {
      customer,
      stats: {
        visitCount: visits,
        lifetimeSpend: seeMoney ? spend : 0,
        averageVisitValue: seeMoney && visits ? Math.round(spend / visits) : 0,
        firstVisitAt: stats?.firstVisitAt?.toISOString() ?? null,
        lastVisitAt: stats?.lastVisitAt?.toISOString() ?? null,
        daysSinceLastVisit: stats?.lastVisitAt ? Math.floor((Date.now() - stats.lastVisitAt.getTime()) / 86400_000) : null,
        cancelledCount: stats?.cancelledCount ?? 0,
        noShowCount: stats?.noShowCount ?? 0,
        favoriteService: stats?.favoriteServiceId ? { id: stats.favoriteServiceId, name: stats.favoriteServiceName!, count: topServices.find((s) => s.serviceId === stats.favoriteServiceId)?.count ?? 0 } : null,
        favoriteStaff: stats?.favoriteStaffId ? { id: stats.favoriteStaffId, name: stats.favoriteStaffName!, count: staffUsed.find((s) => s.staffId === stats.favoriteStaffId)?.count ?? 0 } : null,
        visitsPerMonth: monthsActive && visits ? Number((visits / monthsActive).toFixed(1)) : null,
      },
      account,
      upcoming: upcoming.map(toSummary),
      recentAppointments: recent.map(toSummary),
      topServices,
      staffUsed,
      invoices,
      payments,
      packages,
      offersUsed,
      communications,
      suggestion: stats?.favoriteServiceId
        ? {
            serviceId: stats.favoriteServiceId,
            serviceName: stats.favoriteServiceName!,
            staffId: stats.favoriteStaffId,
            staffName: stats.favoriteStaffName,
            weekday: habit.rows[0]?.weekday ?? null,
            hour: habit.rows[0]?.hour ?? null,
          }
        : null,
    };
  }),
);

r.post('/', { summary: 'Add a customer (refuses duplicates by mobile number)', permissions: ['customers.create'], body: customerSchema }, async ({ tx, auth, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const org = await loadOrg(t, orgId);
    if (body.preferredBranchId && !auth.branchIds.includes(body.preferredBranchId)) throw new AppError(403, 'BRANCH_ACCESS_DENIED', "You don't have access to this branch.");
    const id = await createCustomerRecord(t, auth, org, body, { registeredBranchId: body.preferredBranchId ?? auth.branchIds[0] ?? null });
    return loadCustomerDetail(t, auth, orgId, id, await loadSettings(t, orgId));
  }),
);

r.post('/quick', { summary: 'Quick add (name + mobile) from booking, walk-in or billing', permissions: ['customers.create'], body: quickCustomerSchema }, async ({ tx, auth, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const org = await loadOrg(t, orgId);
    const id = await createCustomerRecord(t, auth, org, body, { registeredBranchId: auth.branchIds[0] ?? null });
    return loadCustomerDetail(t, auth, orgId, id, await loadSettings(t, orgId));
  }),
);

r.put('/:id', { summary: 'Edit a customer', permissions: ['customers.update'], body: customerUpdateSchema }, async ({ tx, auth, params, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const org = await loadOrg(t, orgId);
    const settings = await loadSettings(t, orgId);
    const before = await t.selectFrom('customers').selectAll().where('organizationId', '=', orgId).where('id', '=', params.id!).executeTakeFirst();
    if (!before) throw notFound('Customer');
    if (body.status === 'archived' && !hasPermission(auth, 'customers.archive')) throw new AppError(403, 'FORBIDDEN', "You don't have permission to archive customers.");
    const mobile = body.mobile !== undefined ? optionalPhone(body.mobile, org.callingCode, 'mobile') : undefined;
    if (mobile && mobile !== before.mobile) {
      const dup = await t.selectFrom('customers').select(['id', 'fullName', 'customerCode']).where('organizationId', '=', orgId).where('mobile', '=', mobile).where('status', '!=', 'archived').where('id', '!=', before.id).executeTakeFirst();
      if (dup) throw new AppError(409, 'DUPLICATE_CUSTOMER', `This mobile number already belongs to ${dup.fullName} (${dup.customerCode}).`, { existing: dup });
    }
    const { preferences, marketingConsent, creditLimit, ...rest } = body;
    if (creditLimit !== undefined && !hasPermission(auth, 'billing.override_credit_limit') && !hasPermission(auth, 'ledger.adjust')) {
      throw new AppError(403, 'FORBIDDEN', 'Only a manager can change a credit limit.');
    }
    await t
      .updateTable('customers')
      .set({
        updatedAt: new Date(),
        ...rest,
        ...(mobile !== undefined ? { mobile } : {}),
        ...(body.whatsappNumber !== undefined ? { whatsappNumber: optionalPhone(body.whatsappNumber, org.callingCode, 'whatsappNumber') } : {}),
        ...(body.email !== undefined ? { email: body.email?.toLowerCase() ?? null } : {}),
        ...(creditLimit !== undefined ? { creditLimit } : {}),
        ...(marketingConsent !== undefined && marketingConsent !== before.marketingConsent ? { marketingConsent, marketingConsentAt: marketingConsent ? new Date() : before.marketingConsentAt } : {}),
      })
      .where('id', '=', before.id)
      .execute();
    if (marketingConsent !== undefined && marketingConsent !== before.marketingConsent) {
      await t.insertInto('consentEvents').values({ organizationId: orgId, customerId: before.id, consentType: 'marketing', granted: marketingConsent, source: 'in_person', recordedBy: auth.userId }).execute();
    }
    if (preferences) await savePreferences(t, orgId, before.id, preferences);
    const after = await t.selectFrom('customers').selectAll().where('id', '=', before.id).executeTakeFirstOrThrow();
    await audit(t, auth, { action: 'customer.updated', entityType: 'customer', entityId: before.id, summary: `Customer ${after.fullName} updated`, before, after });
    return loadCustomerDetail(t, auth, orgId, before.id, settings);
  }),
);

r.put('/:id/preferences', { summary: 'Update communication preferences and consent (recorded with a timestamp)', permissions: ['customers.update'], body: customerPreferencesSchema }, async ({ tx, auth, params, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const settings = await loadSettings(t, orgId);
    const customer = await t.selectFrom('customers').select(['id', 'marketingConsent', 'fullName']).where('organizationId', '=', orgId).where('id', '=', params.id!).executeTakeFirst();
    if (!customer) throw notFound('Customer');
    await savePreferences(t, orgId, customer.id, body.preferences);
    if (body.marketingConsent !== undefined && body.marketingConsent !== customer.marketingConsent) {
      await t.updateTable('customers').set({ marketingConsent: body.marketingConsent, marketingConsentAt: new Date() }).where('id', '=', customer.id).execute();
      await t.insertInto('consentEvents').values({ organizationId: orgId, customerId: customer.id, consentType: 'marketing', granted: body.marketingConsent, source: body.source, recordedBy: auth.userId }).execute();
    }
    await audit(t, auth, { action: 'customer.preferences_updated', entityType: 'customer', entityId: customer.id, summary: `Communication preferences updated for ${customer.fullName}`, after: { marketingConsent: body.marketingConsent, preferences: body.preferences } });
    return loadCustomerDetail(t, auth, orgId, customer.id, settings);
  }),
);

r.delete('/:id', { summary: 'Archive a customer (history is kept)', permissions: ['customers.archive'], status: 204 }, async ({ tx, auth, params }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const row = await t.updateTable('customers').set({ status: 'archived' }).where('organizationId', '=', orgId).where('id', '=', params.id!).returning(['id', 'fullName']).executeTakeFirst();
    if (!row) throw notFound('Customer');
    await audit(t, auth, { action: 'customer.archived', entityType: 'customer', entityId: row.id, summary: `Customer ${row.fullName} archived` });
    return undefined;
  }),
);

// ───────────── Segments ─────────────
const segments = createRouter('/segments', 'Customers');

segments.get('/', { summary: 'Saved customer segments with live counts', permissions: ['customers.view'] }, async ({ tx, auth }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const rows = await t.selectFrom('segments').selectAll().where('organizationId', '=', orgId).orderBy('name').execute();
    const out = [];
    for (const s of rows) {
      const filter = segmentFilterSchema.parse(s.filter);
      const { n } = await segmentQuery(t, orgId, filter).select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
      out.push({ id: s.id, name: s.name, description: s.description, filter, customerCount: n });
    }
    return out;
  }),
);

segments.post('/preview', { summary: 'Count and sample customers for a filter', permissions: ['customers.view'], body: segmentFilterSchema, status: 200 }, async ({ tx, auth, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const settings = await loadSettings(t, orgId);
    const { n } = await segmentQuery(t, orgId, body).select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    const sample = await segmentQuery(t, orgId, body)
      .select(['c.id', 'c.fullName', 'c.mobile', 'c.customerCode', 'cs.lastVisitAt', sql<number>`coalesce(cs.lifetime_spend, 0)`.as('lifetimeSpend'), sql<number>`coalesce(cs.visit_count, 0)`.as('visitCount')])
      .orderBy('cs.lastVisitAt', (o) => o.desc().nullsLast())
      .limit(10)
      .execute();
    const visible = canSeeContact(auth, settings);
    return { count: n, sample: sample.map((s) => maskContact({ ...s, lastVisitAt: s.lastVisitAt?.toISOString() ?? null }, visible)) };
  }),
);

segments.post('/', { summary: 'Save a segment', permissions: ['campaigns.manage', 'customers.update'], body: segmentSchema }, async ({ tx, auth, body }) =>
  tx(async (t) => {
    const row = await t.insertInto('segments').values({ organizationId: requireOrgId(auth), name: body.name, description: body.description, filter: JSON.stringify(body.filter), createdBy: auth.userId }).returningAll().executeTakeFirstOrThrow();
    await audit(t, auth, { action: 'segment.created', entityType: 'segment', entityId: row.id, after: { name: body.name, filter: body.filter } });
    return row;
  }),
);

segments.delete('/:id', { summary: 'Delete a saved segment', permissions: ['campaigns.manage', 'customers.update'], status: 204 }, async ({ tx, auth, params }) =>
  tx(async (t) => {
    const row = await t.deleteFrom('segments').where('organizationId', '=', requireOrgId(auth)).where('id', '=', params.id!).returning(['id', 'name']).executeTakeFirst();
    if (!row) throw notFound('Segment');
    await audit(t, auth, { action: 'segment.deleted', entityType: 'segment', entityId: row.id, summary: `Segment ${row.name} deleted` });
    return undefined;
  }),
);

export const customerRoutes = r;
export const segmentRoutes = segments;
