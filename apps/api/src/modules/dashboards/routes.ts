import { dashboardQuery, zDate, zId } from '@salon/shared';
import { z } from 'zod';
import { AppError } from '../../core/errors.js';
import { assertBranchAccess, branchFilter, requireOrgId } from '../../core/auth-context.js';
import { createRouter } from '../../core/router.js';
import { addDays, todayIn, zoned } from '../../core/time.js';
import { loadOrg, loadSettings } from '../../core/validation.js';
import { canSeeContact, maskContact } from '../customers/service.js';
import { loadStaffMetrics } from '../analytics/metrics.js';
import { loadSalonNow } from './now.js';
import { branchDashboard, ownerDashboard } from './service.js';

const r = createRouter('/dashboard', 'Dashboards');

r.get('/owner', { summary: 'Owner dashboard: revenue, appointments, customers, staff, pending payments, branches and alerts', permissions: ['dashboard.business'], query: dashboardQuery }, async ({ tx, auth, query }) =>
  tx((t) => ownerDashboard(t, auth, requireOrgId(auth), query)),
);

r.get('/branch', { summary: 'Branch manager dashboard: the salon right now, today’s money and alerts', permissions: ['dashboard.branch', 'dashboard.business'], query: z.object({ branchId: zId }) }, async ({ tx, auth, query }) => {
  assertBranchAccess(auth, query.branchId);
  return tx((t) => branchDashboard(t, auth, requireOrgId(auth), query.branchId));
});

r.get('/now', { summary: 'Lightweight live status (staff available, serving, waiting) for polling', permissions: ['dashboard.branch', 'dashboard.business', 'appointments.view'], query: z.object({ branchId: zId.optional() }) }, async ({ tx, auth, query }) =>
  tx(async (t) => {
    const rows = await loadSalonNow(t, requireOrgId(auth), branchFilter(auth, query.branchId));
    return query.branchId ? rows[0] ?? null : rows;
  }),
);

r.get('/my-day', { summary: 'Staff home: today’s schedule, current and next appointment', permissions: ['appointments.view_own'], query: z.object({ date: zDate.optional() }) }, async ({ tx, auth, query }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    if (!auth.staffId) throw new AppError(404, 'NOT_FOUND', 'Your login is not linked to a team member profile yet. Ask your manager to link it.');
    const staff = await t.selectFrom('staff as s').innerJoin('branches as b', 'b.id', 's.branchId').select(['s.id', 's.displayName', 's.branchId', 'b.name as branchName', 'b.timezone']).where('s.id', '=', auth.staffId).executeTakeFirstOrThrow();
    const settings = await loadSettings(t, orgId);
    const org = await loadOrg(t, orgId);
    const date = query.date ?? todayIn(staff.timezone);
    const dayStart = zoned(date, '00:00', staff.timezone);
    const items = await t
      .selectFrom('appointmentItems as ai')
      .innerJoin('appointments as a', 'a.id', 'ai.appointmentId')
      .innerJoin('customers as c', 'c.id', 'a.customerId')
      .innerJoin('services as s', 's.id', 'ai.serviceId')
      .select(['ai.id as itemId', 'a.id as appointmentId', 'a.bookingNumber', 'a.status as appointmentStatus', 'ai.status as itemStatus', 'ai.startAt', 'ai.endAt', 'ai.durationMinutes', 'a.notes', 'c.fullName as customerName', 'c.mobile as customerMobile', 's.name as serviceName', 's.description as serviceDescription'])
      .where('ai.staffId', '=', staff.id)
      .where('ai.startAt', '>=', dayStart.toJSDate())
      .where('ai.startAt', '<', dayStart.plus({ days: 1 }).toJSDate())
      .where('a.organizationId', '=', orgId)
      .orderBy('ai.startAt')
      .execute();
    const visible = canSeeContact(auth, settings);
    const now = Date.now();
    const shaped = items.map((i) => ({
      itemId: i.itemId,
      appointmentId: i.appointmentId,
      bookingNumber: i.bookingNumber,
      status: i.appointmentStatus,
      startAt: i.startAt!.toISOString(),
      endAt: i.endAt!.toISOString(),
      durationMinutes: i.durationMinutes,
      service: i.serviceName,
      serviceDescription: i.serviceDescription,
      customerName: i.customerName,
      customerMobile: maskContact({ mobile: i.customerMobile }, visible).mobile,
      notes: i.notes,
    }));
    const active = shaped.filter((i) => !['cancelled', 'no_show'].includes(i.status));
    const current = active.find((i) => i.status === 'in_service') ?? active.find((i) => i.status === 'checked_in' && new Date(i.startAt).getTime() <= now && now < new Date(i.endAt).getTime()) ?? null;
    const next = active.filter((i) => i.status !== 'completed' && i.itemId !== current?.itemId && new Date(i.startAt).getTime() > now - 5 * 60_000)[0] ?? null;

    let performance: { completedThisMonth: number; revenueThisMonth: number } | null = null;
    if (settings.staffCanViewOwnPerformance) {
      const monthStart = `${date.slice(0, 7)}-01`;
      const [m] = await loadStaffMetrics(t, orgId, [staff.branchId], { from: monthStart, to: date }, [staff.id]);
      performance = { completedThisMonth: m?.completedAppointments ?? 0, revenueThisMonth: m?.revenue ?? 0 };
    }
    const tomorrowCount = await t
      .selectFrom('appointmentItems as ai')
      .innerJoin('appointments as a', 'a.id', 'ai.appointmentId')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('ai.staffId', '=', staff.id)
      .where('a.localDate', '=', addDays(date, 1))
      .where('a.status', 'in', ['scheduled', 'confirmed', 'checked_in'])
      .executeTakeFirstOrThrow();
    return {
      date,
      timezone: staff.timezone,
      staff: { id: staff.id, displayName: staff.displayName, branchName: staff.branchName },
      currency: org.currency,
      summary: { total: active.length, completed: active.filter((i) => i.status === 'completed').length, remaining: active.filter((i) => !['completed'].includes(i.status)).length, cancelled: shaped.filter((i) => ['cancelled', 'no_show'].includes(i.status)).length, tomorrow: tomorrowCount.n },
      current,
      next,
      schedule: shaped,
      performance,
    };
  }),
);

export const dashboardRoutes = r;
