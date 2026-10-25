import { walkInStage, type AppointmentDto, type AppointmentItemDto } from '@salon/shared';
import { sql } from 'kysely';
import type { AuthContext } from '../../core/auth-context.js';
import { toIso } from '../../core/time.js';
import type { OrgSettings } from '../../core/validation.js';
import type { Tx } from '../../db/tenant.js';
import { canSeeContact, maskContact } from '../customers/service.js';

const NO_MATCH = '00000000-0000-0000-0000-000000000000';

/** Loads full appointment DTOs (customer, service lines, billing state) for a set of ids, preserving input order. */
export async function loadAppointmentDtos(tx: Tx, auth: AuthContext, orgId: string, ids: string[], settings: OrgSettings): Promise<AppointmentDto[]> {
  if (!ids.length) return [];
  const rows = await tx
    .selectFrom('appointments as a')
    .innerJoin('branches as b', 'b.id', 'a.branchId')
    .innerJoin('customers as c', 'c.id', 'a.customerId')
    .leftJoin('customerAccounts as ca', 'ca.customerId', 'a.customerId')
    .leftJoin('invoices as i', 'i.id', 'a.invoiceId')
    .leftJoin('users as u', 'u.id', 'a.createdBy')
    .select([
      'a.id',
      'a.bookingNumber',
      'a.branchId',
      'b.name as branchName',
      'a.status',
      'a.source',
      'a.localDate',
      'a.startAt',
      'a.endAt',
      'a.queueNumber',
      'a.totalDurationMinutes',
      'a.estimatedAmount',
      'a.notes',
      'a.internalNotes',
      'a.arrivedAt',
      'a.checkedInAt',
      'a.serviceStartedAt',
      'a.completedAt',
      'a.cancelledAt',
      'a.cancellationReason',
      'a.rescheduleCount',
      'a.invoiceId',
      'a.version',
      'a.createdAt',
      'c.id as customerId',
      'c.fullName as customerName',
      'c.mobile as customerMobile',
      'c.customerCode',
      sql<number>`greatest(coalesce(ca.balance, 0), 0)`.as('outstanding'),
      'i.invoiceNumber',
      'i.paymentStatus',
      'u.fullName as createdByName',
    ])
    .where('a.organizationId', '=', orgId)
    .where('a.id', 'in', ids)
    .execute();

  const items = await tx
    .selectFrom('appointmentItems as ai')
    .innerJoin('services as s', 's.id', 'ai.serviceId')
    .innerJoin('serviceCategories as sc', 'sc.id', 's.categoryId')
    .leftJoin('staff as st', 'st.id', 'ai.staffId')
    .select([
      'ai.id',
      'ai.appointmentId',
      'ai.serviceId',
      's.name as serviceName',
      'sc.color as categoryColor',
      'ai.staffId',
      'st.displayName as staffName',
      'st.calendarColor as staffColor',
      'ai.startAt',
      'ai.endAt',
      'ai.durationMinutes',
      'ai.bufferMinutes',
      'ai.price',
      'ai.status',
      'ai.customerPackageItemId',
    ])
    .where('ai.appointmentId', 'in', ids.length ? ids : [NO_MATCH])
    .orderBy('ai.sortOrder')
    .execute();

  const visible = canSeeContact(auth, settings);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => !!r)
    .map((a): AppointmentDto => {
      const lines: AppointmentItemDto[] = items
        .filter((i) => i.appointmentId === a.id)
        .map((i) => ({
          id: i.id,
          serviceId: i.serviceId,
          serviceName: i.serviceName,
          categoryColor: i.categoryColor,
          staffId: i.staffId,
          staffName: i.staffName,
          staffColor: i.staffColor,
          startAt: toIso(i.startAt),
          endAt: toIso(i.endAt),
          durationMinutes: i.durationMinutes,
          bufferMinutes: i.bufferMinutes,
          price: i.price,
          status: i.status,
          customerPackageItemId: i.customerPackageItemId,
        }));
      const customer = maskContact({ mobile: a.customerMobile }, visible);
      return {
        id: a.id,
        bookingNumber: a.bookingNumber,
        branchId: a.branchId,
        branchName: a.branchName,
        status: a.status as AppointmentDto['status'],
        source: a.source as AppointmentDto['source'],
        localDate: a.localDate,
        startAt: toIso(a.startAt),
        endAt: toIso(a.endAt),
        queueNumber: a.queueNumber,
        totalDurationMinutes: a.totalDurationMinutes,
        estimatedAmount: a.estimatedAmount,
        customer: { id: a.customerId, fullName: a.customerName, mobile: customer.mobile, customerCode: a.customerCode, outstanding: Number(a.outstanding) },
        items: lines,
        notes: a.notes,
        internalNotes: a.internalNotes,
        arrivedAt: toIso(a.arrivedAt),
        checkedInAt: toIso(a.checkedInAt),
        serviceStartedAt: toIso(a.serviceStartedAt),
        completedAt: toIso(a.completedAt),
        cancelledAt: toIso(a.cancelledAt),
        cancellationReason: a.cancellationReason,
        rescheduleCount: a.rescheduleCount,
        invoiceId: a.invoiceId,
        invoiceNumber: a.invoiceNumber,
        paymentStatus: (a.paymentStatus as AppointmentDto['paymentStatus']) ?? null,
        walkInStage: a.source === 'walk_in' ? walkInStage(a.status as AppointmentDto['status'], a.invoiceId !== null) : null,
        version: a.version,
        createdAt: a.createdAt.toISOString(),
        createdByName: a.createdByName,
      };
    });
}

/** Staff-role users only see appointments in which they perform a service. */
export function visibleToOwnScope(dto: AppointmentDto, staffId: string | null): boolean {
  return !!staffId && dto.items.some((i) => i.staffId === staffId);
}
