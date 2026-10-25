import { auditQuery } from '@salon/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import { branchFilter, hasAnyPermission, hasPermission, nonEmpty, requireOrgId } from '../../core/auth-context.js';
import { createRouter, paged } from '../../core/router.js';
import { localDateConditionsTz } from '../../core/sql.js';
import { loadOrg, loadSettings } from '../../core/validation.js';
import { canSeeContact, customerSearchCondition, maskContact } from '../customers/service.js';

// ───────────── Global search ─────────────
const search = createRouter('/search', 'Search');

/** An exact customer-code match ranks first; a full mobile number (10+ digits) ranks next; partial matches follow. */
function exactCodeRank(q: string) {
  return sql<boolean>`(upper(c.customer_code) = upper(${q}))`;
}

function fullMobileRank(q: string) {
  const digits = q.replace(/D/g, '');
  return sql<boolean>`(${digits.length >= 10} and c.mobile like '%' || ${digits})`;
}

export interface SearchHit {
  type: 'customer' | 'staff' | 'appointment' | 'invoice' | 'payment';
  id: string;
  title: string;
  subtitle: string;
  link: string;
}

search.get('/', { summary: 'One search box for customers, team, bookings, bills and receipts (name, mobile, code, booking or bill number)', permissions: ['customers.view', 'staff.view', 'appointments.view', 'billing.view', 'payments.collect'], query: z.object({ q: z.string().trim().min(2).max(60) }) }, async ({ tx, auth, query }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const settings = await loadSettings(t, orgId);
    const visible = canSeeContact(auth, settings);
    const branches = nonEmpty(auth.branchIds);
    const like = `%${query.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    const prefix = `${query.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    const groups: Record<string, SearchHit[]> = { customers: [], team: [], appointments: [], bills: [], payments: [] };

    const jobs: Array<Promise<void>> = [];
    if (hasPermission(auth, 'customers.view')) {
      jobs.push(
        t.selectFrom('customers as c').select(['c.id', 'c.fullName', 'c.customerCode', 'c.mobile']).where('c.organizationId', '=', orgId).where('c.status', '!=', 'archived').where(customerSearchCondition(query.q)).orderBy(exactCodeRank(query.q), 'desc').orderBy(fullMobileRank(query.q), 'desc').orderBy(sql`(c.full_name ilike ${prefix})`, 'desc').orderBy('c.fullName').limit(6).execute().then((rows) => {
          groups.customers = rows.map((c) => ({ type: 'customer', id: c.id, title: c.fullName, subtitle: `${c.customerCode}${c.mobile ? ` · ${maskContact({ mobile: c.mobile }, visible).mobile}` : ''}`, link: `/customers/${c.id}` }));
        }),
      );
    }
    if (hasPermission(auth, 'staff.view')) {
      jobs.push(
        t.selectFrom('staff').select(['id', 'fullName', 'displayName', 'employeeCode', 'designation']).where('organizationId', '=', orgId).where('branchId', 'in', branches).where((eb) => eb.or([eb('fullName', 'ilike', like), eb('displayName', 'ilike', like), eb('employeeCode', 'ilike', prefix)])).limit(5).execute().then((rows) => {
          groups.team = rows.map((s) => ({ type: 'staff', id: s.id, title: s.fullName, subtitle: `${s.employeeCode}${s.designation ? ` · ${s.designation}` : ''}`, link: `/staff/${s.id}` }));
        }),
      );
    }
    if (hasAnyPermission(auth, ['appointments.view'])) {
      jobs.push(
        t.selectFrom('appointments as a').innerJoin('customers as c', 'c.id', 'a.customerId').select(['a.id', 'a.bookingNumber', 'a.status', 'a.startAt', 'c.fullName']).where('a.organizationId', '=', orgId).where('a.branchId', 'in', branches).where('a.bookingNumber', 'ilike', prefix).orderBy('a.startAt', 'desc').limit(5).execute().then((rows) => {
          groups.appointments = rows.map((a) => ({ type: 'appointment', id: a.id, title: `${a.bookingNumber} · ${a.fullName}`, subtitle: `${a.status.replace('_', ' ')}${a.startAt ? ` · ${a.startAt.toISOString().slice(0, 10)}` : ''}`, link: `/appointments/${a.id}` }));
        }),
      );
    }
    if (hasPermission(auth, 'billing.view')) {
      jobs.push(
        t.selectFrom('invoices as i').innerJoin('customers as c', 'c.id', 'i.customerId').select(['i.id', 'i.invoiceNumber', 'i.grandTotal', 'i.paymentStatus', 'c.fullName']).where('i.organizationId', '=', orgId).where('i.branchId', 'in', branches).where('i.invoiceNumber', 'ilike', like).orderBy('i.issuedAt', 'desc').limit(5).execute().then((rows) => {
          groups.bills = rows.map((i) => ({ type: 'invoice', id: i.id, title: `${i.invoiceNumber} · ${i.fullName}`, subtitle: i.paymentStatus, link: `/billing/bills/${i.id}` }));
        }),
      );
    }
    if (hasAnyPermission(auth, ['billing.view', 'payments.collect'])) {
      jobs.push(
        t.selectFrom('payments as p').innerJoin('customers as c', 'c.id', 'p.customerId').select(['p.id', 'p.receiptNumber', 'p.amount', 'c.fullName']).where('p.organizationId', '=', orgId).where('p.branchId', 'in', branches).where('p.receiptNumber', 'ilike', like).orderBy('p.receivedAt', 'desc').limit(5).execute().then((rows) => {
          groups.payments = rows.map((p) => ({ type: 'payment', id: p.id, title: `${p.receiptNumber} · ${p.fullName}`, subtitle: 'Receipt', link: `/billing/payments/${p.id}` }));
        }),
      );
    }
    await Promise.all(jobs);
    return groups;
  }),
);

// ───────────── Activity log ─────────────
const audit = createRouter('/audit', 'Activity log');

audit.get('/', { summary: 'Who did what and when (bills, payments, bookings, settings)', permissions: ['audit.view'], query: auditQuery }, async ({ tx, auth, query }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const org = await loadOrg(t, orgId);
    let base = t
      .selectFrom('auditLogs as l')
      .leftJoin('users as u', 'u.id', 'l.userId')
      .where('l.organizationId', '=', orgId)
      // Branch-scoped managers see their branches' activity; salon-wide settings changes only for salon-wide users.
      .where((eb) => eb.or([eb('l.branchId', 'in', branchFilter(auth)), ...(auth.allBranches ? [eb('l.branchId', 'is', null)] : [])]));
    if (query.entityType) {
      // "staff" also covers staff_leave and staff_time_block, "organization" also covers organization_settings.
      const escaped = query.entityType.replace(/[\\%_]/g, (c) => `\\${c}`);
      const related = `${escaped}\\_%`;
      base = base.where(sql<boolean>`(l.entity_type = ${query.entityType} or l.entity_type like ${related})`);
    }
    if (query.entityId) base = base.where('l.entityId', '=', query.entityId);
    if (query.userId) base = base.where('l.userId', '=', query.userId);
    if (query.action) base = base.where('l.action', 'like', `${query.action}%`);
    for (const c of localDateConditionsTz('l.created_at', org.timezone, query.from, query.to)) base = base.where(c);
    if (query.search) base = base.where((eb) => eb.or([eb('l.summary', 'ilike', `%${query.search}%`), eb('l.action', 'ilike', `%${query.search}%`)]));
    const { n } = await base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    const rows = await base
      .select(['l.id', 'l.createdAt', 'l.action', 'l.entityType', 'l.entityId', 'l.summary', 'l.oldValues', 'l.newValues', 'l.ip', 'l.userAgent', 'u.fullName as userName'])
      .orderBy('l.id', 'desc')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .execute();
    return paged(rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })), n, query.page, query.pageSize);
  }),
);

export const searchRoutes = search;
export const auditRoutes = audit;
