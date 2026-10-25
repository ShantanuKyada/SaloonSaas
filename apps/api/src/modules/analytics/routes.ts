import { dashboardQuery, zDate } from '@salon/shared';
import { z } from 'zod';
import { sql } from 'kysely';
import { AppError } from '../../core/errors.js';
import { branchFilter, hasPermission, requireOrgId } from '../../core/auth-context.js';
import { createRouter } from '../../core/router.js';
import { loadSettings } from '../../core/validation.js';
import { loadServiceDemand, loadStaffMetrics } from './metrics.js';

const r = createRouter('/analytics', 'Analytics');

r.get('/staff', { summary: 'Staff performance side by side: appointments, revenue, services, customers, utilization', permissions: ['staff.performance'], query: dashboardQuery }, async ({ tx, auth, query }) =>
  tx(async (t) => ({ range: { from: query.from, to: query.to }, staff: await loadStaffMetrics(t, requireOrgId(auth), branchFilter(auth, query.branchId), query) })),
);

r.get('/staff/me', { summary: 'Own performance (only when the owner has switched this on)', permissions: ['appointments.view_own'], query: z.object({ from: zDate, to: zDate }) }, async ({ tx, auth, query }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const settings = await loadSettings(t, orgId);
    if (!settings.staffCanViewOwnPerformance && !hasPermission(auth, 'staff.performance')) {
      throw new AppError(403, 'FORBIDDEN', 'Your salon has not turned on performance figures for team members.');
    }
    if (!auth.staffId) throw new AppError(404, 'NOT_FOUND', 'Your login is not linked to a team member profile.');
    const [mine] = await loadStaffMetrics(t, orgId, auth.branchIds, query, [auth.staffId]);
    return { range: { from: query.from, to: query.to }, metrics: mine ?? null };
  }),
);

r.get('/services', { summary: 'Service demand: bookings, revenue, average ticket and top staff, derived from real data', permissions: ['reports.financial', 'reports.operations'], query: dashboardQuery }, async ({ tx, auth, query }) =>
  tx(async (t) => {
    const rows = await loadServiceDemand(t, requireOrgId(auth), branchFilter(auth, query.branchId), query);
    const active = rows.filter((s) => s.bookings > 0 || s.billedQuantity > 0);
    return {
      range: { from: query.from, to: query.to },
      services: active,
      // Services that are offered but barely sell: derived, not hard-coded.
      lowestPerforming: rows.filter((s) => s.billedQuantity === 0).slice(0, 5).map((s) => ({ serviceId: s.serviceId, name: s.name, category: s.category })).concat(
        [...active].sort((a, b) => a.revenue - b.revenue).slice(0, 3).map((s) => ({ serviceId: s.serviceId, name: s.name, category: s.category })),
      ).slice(0, 5),
    };
  }),
);

r.get('/customers', { summary: 'Retention: lifetime value, visit frequency, repeat rate, churn and customers at risk', permissions: ['reports.operations', 'reports.financial'], query: dashboardQuery.pick({ branchId: true }) }, async ({ tx, auth, query }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const branches = branchFilter(auth, query.branchId);
    const b = sql.join(branches.map((x) => sql`${x}::uuid`));

    const summary = await sql<{ withVisit: number; repeat: number; avgInterval: number | null; avgLtv: number | null; inactive30: number; inactive60: number; inactive90: number }>`
      select count(*) filter (where cs.visit_count > 0)::int as "withVisit",
             count(*) filter (where cs.visit_count >= 2)::int as repeat,
             avg(extract(epoch from (cs.last_visit_at - cs.first_visit_at)) / 86400 / nullif(cs.visit_count - 1, 0)) filter (where cs.visit_count >= 2) as "avgInterval",
             avg(cs.lifetime_spend) filter (where cs.visit_count > 0) as "avgLtv",
             count(*) filter (where cs.visit_count > 0 and cs.last_visit_at < now() - interval '30 days')::int as inactive30,
             count(*) filter (where cs.visit_count > 0 and cs.last_visit_at < now() - interval '60 days')::int as inactive60,
             count(*) filter (where cs.visit_count > 0 and cs.last_visit_at < now() - interval '90 days')::int as inactive90
        from customer_stats cs join customers c on c.id = cs.customer_id
       where cs.organization_id = ${orgId} and c.status = 'active'
         and (cs.last_branch_id is null or cs.last_branch_id in (${b}))`.execute(t);
    const s = summary.rows[0]!;

    const retention = await sql<{ earlier: number; kept: number }>`
      with earlier as (select distinct customer_id from invoices where organization_id = ${orgId} and status = 'issued' and branch_id in (${b}) and invoice_date between current_date - 180 and current_date - 91),
           recent as (select distinct customer_id from invoices where organization_id = ${orgId} and status = 'issued' and branch_id in (${b}) and invoice_date between current_date - 90 and current_date)
      select (select count(*) from earlier)::int as earlier, (select count(*) from earlier e join recent r using (customer_id))::int as kept`.execute(t);
    const ret = retention.rows[0]!;

    const avgTicket = await sql<{ bills: number; revenue: number }>`
      select count(*)::int as bills, coalesce(sum(grand_total - tax_total), 0)::bigint as revenue from invoices
       where organization_id = ${orgId} and status = 'issued' and branch_id in (${b}) and invoice_date >= current_date - 90`.execute(t);

    const atRisk = await sql<{ id: string; fullName: string; visits: number; ltv: number; lastVisitAt: Date; daysSince: number; usualGapDays: number }>`
      select c.id, c.full_name as "fullName", cs.visit_count as visits, cs.lifetime_spend as ltv, cs.last_visit_at as "lastVisitAt",
             extract(day from now() - cs.last_visit_at)::int as "daysSince",
             round((extract(epoch from (cs.last_visit_at - cs.first_visit_at)) / 86400 / (cs.visit_count - 1))::numeric)::int as "usualGapDays"
        from customer_stats cs join customers c on c.id = cs.customer_id
       where cs.organization_id = ${orgId} and c.status = 'active' and cs.visit_count >= 2
         and cs.last_visit_at > now() - interval '365 days'
         and (cs.last_branch_id is null or cs.last_branch_id in (${b}))
         and extract(epoch from now() - cs.last_visit_at) / 86400 > 1.5 * (extract(epoch from (cs.last_visit_at - cs.first_visit_at)) / 86400 / (cs.visit_count - 1))
       order by cs.lifetime_spend desc limit 20`.execute(t);

    const top = await t
      .selectFrom('customerStats as cs')
      .innerJoin('customers as c', 'c.id', 'cs.customerId')
      .leftJoin('services as fs', 'fs.id', 'cs.favoriteServiceId')
      .leftJoin('staff as fst', 'fst.id', 'cs.favoriteStaffId')
      .select(['c.id', 'c.fullName', 'cs.visitCount', 'cs.lifetimeSpend', 'cs.lastVisitAt', 'fs.name as favoriteService', 'fst.displayName as favoriteStaff'])
      .where('cs.organizationId', '=', orgId)
      .where('c.status', '=', 'active')
      .where('cs.lifetimeSpend', '>', 0)
      .orderBy('cs.lifetimeSpend', 'desc')
      .limit(10)
      .execute();

    const earlier = Number(ret.earlier);
    return {
      customersWithVisits: Number(s.withVisit),
      repeatCustomers: Number(s.repeat),
      repeatVisitRatePercent: s.withVisit ? Math.round((Number(s.repeat) / Number(s.withVisit)) * 100) : 0,
      averageDaysBetweenVisits: s.avgInterval === null ? null : Math.round(Number(s.avgInterval)),
      averageLifetimeValue: Math.round(Number(s.avgLtv ?? 0)),
      averageTransactionValue: avgTicket.rows[0]!.bills ? Math.round(Number(avgTicket.rows[0]!.revenue) / avgTicket.rows[0]!.bills) : 0,
      retentionPercent: earlier ? Math.round((Number(ret.kept) / earlier) * 100) : null,
      churnPercent: earlier ? Math.round(((earlier - Number(ret.kept)) / earlier) * 100) : null,
      inactive: { days30: Number(s.inactive30), days60: Number(s.inactive60), days90: Number(s.inactive90) },
      atRisk: atRisk.rows.map((x) => ({ ...x, lastVisitAt: new Date(x.lastVisitAt).toISOString() })),
      topCustomers: top.map((c) => ({ id: c.id, fullName: c.fullName, lifetimeSpend: c.lifetimeSpend, visits: c.visitCount, averageVisit: c.visitCount ? Math.round(c.lifetimeSpend / c.visitCount) : 0, daysSinceLastVisit: c.lastVisitAt ? Math.floor((Date.now() - c.lastVisitAt.getTime()) / 86400_000) : null, favoriteService: c.favoriteService, favoriteStaff: c.favoriteStaff })),
      definitions: {
        retention: 'Of customers who visited 91–180 days ago, the share who also visited in the last 90 days.',
        atRisk: 'Customers whose time since last visit is more than 1.5× their usual gap between visits.',
      },
    };
  }),
);

export const analyticsRoutes = r;
