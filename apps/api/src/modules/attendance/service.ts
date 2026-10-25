import type { AttendanceDayDto, AttendanceStatus } from '@salon/shared';
import { sql } from 'kysely';
import { decryptSecret } from '../../core/crypto.js';
import { logger } from '../../core/logger.js';
import { metrics } from '../../core/metrics.js';
import { eachDate, isoWeekday, todayIn, zoned } from '../../core/time.js';
import type { BranchRow } from '../../core/validation.js';
import { withSystem, type Tx } from '../../db/tenant.js';
import { buildBiometricProvider, type RawPunch } from '../../integrations/biometric/providers.js';

// Attendance answers "who came to work?". It is deliberately separate from scheduling availability ("who can take
// a customer right now?"): punching in never makes someone bookable by itself.

export const LATE_GRACE_MINUTES = 10;
export const ABSENT_AFTER_START_MINUTES = 60;
export const MISSING_PUNCH_AFTER_END_MINUTES = 120;
const MINUTE = 60_000;

export interface DayInput {
  date: string;
  now: number;
  scheduled: { start: number; end: number } | null;
  holiday: boolean;
  leaveFull: boolean;
  punches: number[];
}

export interface DayResult {
  status: AttendanceStatus;
  firstIn: number | null;
  lastOut: number | null;
  workedMinutes: number;
  lateMinutes: number;
}

/** Pure decision logic (unit-tested). Times are epoch milliseconds; punches are sorted ascending. */
export function decideAttendance(d: DayInput): DayResult {
  const sorted = [...d.punches].sort((a, b) => a - b);
  const firstIn = sorted[0] ?? null;
  const lastOut = sorted.length >= 2 ? sorted[sorted.length - 1]! : null;
  const worked = firstIn !== null && lastOut !== null ? Math.round((lastOut - firstIn) / MINUTE) : 0;
  const base = { firstIn, lastOut, workedMinutes: worked, lateMinutes: 0 };

  if (d.holiday && !sorted.length) return { ...base, status: 'holiday' };
  if (d.leaveFull && !sorted.length) return { ...base, status: 'on_leave' };
  if (!d.scheduled) return { ...base, status: sorted.length ? 'present' : 'weekly_off' };

  const { start, end } = d.scheduled;
  if (!sorted.length) {
    if (d.now < start + ABSENT_AFTER_START_MINUTES * MINUTE) return { ...base, status: 'not_started' };
    return { ...base, status: 'absent' };
  }
  const late = Math.max(0, Math.round((firstIn! - start) / MINUTE));
  const dayOver = d.now > end + MISSING_PUNCH_AFTER_END_MINUTES * MINUTE;
  if (sorted.length === 1 && dayOver) return { ...base, status: 'missing_punch', lateMinutes: late > LATE_GRACE_MINUTES ? late : 0 };
  const scheduledMinutes = Math.round((end - start) / MINUTE);
  if (lastOut !== null && dayOver && worked < scheduledMinutes * 0.5) return { ...base, status: 'half_day', lateMinutes: late > LATE_GRACE_MINUTES ? late : 0 };
  if (late > LATE_GRACE_MINUTES) return { ...base, status: 'late', lateMinutes: late };
  return { ...base, status: 'present' };
}

/** A branch is tracked when a device is connected there or punches have been received recently. */
export async function isTracked(tx: Tx, orgId: string, branchId: string): Promise<boolean> {
  const integration = await tx
    .selectFrom('organizationIntegrations')
    .select('id')
    .where('organizationId', '=', orgId)
    .where('kind', '=', 'biometric')
    .where('status', '!=', 'inactive')
    .where((eb) => eb.or([eb('branchId', 'is', null), eb('branchId', '=', branchId)]))
    .executeTakeFirst();
  if (integration) return true;
  const punch = await tx
    .selectFrom('attendancePunches')
    .select('id')
    .where('organizationId', '=', orgId)
    .where('branchId', '=', branchId)
    .where('punchedAt', '>', sql<Date>`now() - interval '30 days'`)
    .limit(1)
    .executeTakeFirst();
  return !!punch;
}

/** Recomputes stored attendance for a branch over a date range (manual overrides are never touched). */
export async function recomputeBranch(tx: Tx, orgId: string, branch: BranchRow, from: string, to: string): Promise<number> {
  const tz = branch.timezone;
  const today = todayIn(tz);
  const last = to > today ? today : to;
  if (last < from) return 0;
  if (!(await isTracked(tx, orgId, branch.id))) return 0;
  const dates = eachDate(from, last);
  const rangeStart = zoned(from, '00:00', tz).toJSDate();
  const rangeEnd = zoned(last, '00:00', tz).plus({ days: 1 }).toJSDate();

  const staff = await tx.selectFrom('staff').select(['id']).where('organizationId', '=', orgId).where('branchId', '=', branch.id).where('employmentStatus', 'in', ['active', 'on_notice']).execute();
  if (!staff.length) return 0;
  const ids = staff.map((s) => s.id);
  const [shifts, overrides, leaves, holidays, punches] = await Promise.all([
    tx.selectFrom('staffShifts').select(['staffId', 'weekday', 'startTime', 'endTime']).where('staffId', 'in', ids).execute(),
    tx.selectFrom('staffScheduleOverrides').select(['staffId', 'date', 'isWorking', 'startTime', 'endTime']).where('staffId', 'in', ids).where('date', '>=', from).where('date', '<=', last).execute(),
    tx.selectFrom('staffLeaves').select(['staffId', 'startDate', 'endDate', 'halfDay']).where('staffId', 'in', ids).where('status', '=', 'approved').where('startDate', '<=', last).where('endDate', '>=', from).execute(),
    tx.selectFrom('holidays').select('date').where('organizationId', '=', orgId).where((eb) => eb.or([eb('branchId', 'is', null), eb('branchId', '=', branch.id)])).where('date', '>=', from).where('date', '<=', last).execute(),
    tx.selectFrom('attendancePunches').select(['staffId', 'punchedAt']).where('organizationId', '=', orgId).where('staffId', 'in', ids).where('punchedAt', '>=', rangeStart).where('punchedAt', '<', rangeEnd).execute(),
  ]);
  const manual = await tx.selectFrom('attendanceDays').select(['staffId', 'date']).where('branchId', '=', branch.id).where('date', '>=', from).where('date', '<=', last).where('isManualOverride', '=', true).execute();
  const manualKeys = new Set(manual.map((m) => `${m.staffId}|${m.date}`));
  const holidayDates = new Set(holidays.map((h) => h.date));
  const now = Date.now();

  const rows: Array<{ organizationId: string; branchId: string; staffId: string; date: string; status: AttendanceStatus; scheduledStart: Date | null; scheduledEnd: Date | null; firstIn: Date | null; lastOut: Date | null; workedMinutes: number; lateMinutes: number }> = [];
  for (const date of dates) {
    const weekday = isoWeekday(date);
    const dayStart = zoned(date, '00:00', tz).toMillis();
    const dayEnd = zoned(date, '00:00', tz).plus({ days: 1 }).toMillis();
    for (const s of staff) {
      if (manualKeys.has(`${s.id}|${date}`)) continue;
      const override = overrides.find((o) => o.staffId === s.id && o.date === date);
      let scheduled: { start: number; end: number } | null = null;
      if (override) {
        if (override.isWorking && override.startTime && override.endTime) scheduled = { start: zoned(date, override.startTime, tz).toMillis(), end: zoned(date, override.endTime, tz).toMillis() };
      } else {
        const day = shifts.filter((x) => x.staffId === s.id && x.weekday === weekday);
        if (day.length) scheduled = { start: Math.min(...day.map((x) => zoned(date, x.startTime, tz).toMillis())), end: Math.max(...day.map((x) => zoned(date, x.endTime, tz).toMillis())) };
      }
      const decision = decideAttendance({
        date,
        now,
        scheduled,
        holiday: holidayDates.has(date),
        leaveFull: leaves.some((l) => l.staffId === s.id && l.halfDay === 'none' && date >= l.startDate && date <= l.endDate),
        punches: punches.filter((p) => p.staffId === s.id && p.punchedAt.getTime() >= dayStart && p.punchedAt.getTime() < dayEnd).map((p) => p.punchedAt.getTime()),
      });
      rows.push({
        organizationId: orgId,
        branchId: branch.id,
        staffId: s.id,
        date,
        status: decision.status,
        scheduledStart: scheduled ? new Date(scheduled.start) : null,
        scheduledEnd: scheduled ? new Date(scheduled.end) : null,
        firstIn: decision.firstIn ? new Date(decision.firstIn) : null,
        lastOut: decision.lastOut ? new Date(decision.lastOut) : null,
        workedMinutes: decision.workedMinutes,
        lateMinutes: decision.lateMinutes,
      });
    }
  }
  for (let i = 0; i < rows.length; i += 500) {
    await tx
      .insertInto('attendanceDays')
      .values(rows.slice(i, i + 500))
      .onConflict((oc) =>
        oc
          .columns(['staffId', 'date'])
          .doUpdateSet((eb) => ({
            status: eb.ref('excluded.status'),
            scheduledStart: eb.ref('excluded.scheduledStart'),
            scheduledEnd: eb.ref('excluded.scheduledEnd'),
            firstIn: eb.ref('excluded.firstIn'),
            lastOut: eb.ref('excluded.lastOut'),
            workedMinutes: eb.ref('excluded.workedMinutes'),
            lateMinutes: eb.ref('excluded.lateMinutes'),
            computedAt: new Date(),
          }))
          .where('attendanceDays.isManualOverride', '=', false),
      )
      .execute();
  }
  return rows.length;
}

export async function loadAttendanceDays(tx: Tx, orgId: string, branchIds: string[], filter: { from: string; to: string; staffId?: string }): Promise<AttendanceDayDto[]> {
  let q = tx
    .selectFrom('attendanceDays as a')
    .innerJoin('staff as s', 's.id', 'a.staffId')
    .select(['a.staffId', 's.displayName as staffName', 'a.branchId', 'a.date', 'a.status', 'a.scheduledStart', 'a.scheduledEnd', 'a.firstIn', 'a.lastOut', 'a.workedMinutes', 'a.lateMinutes', 'a.isManualOverride', 'a.overrideReason'])
    .where('a.organizationId', '=', orgId)
    .where('a.branchId', 'in', branchIds)
    .where('a.date', '>=', filter.from)
    .where('a.date', '<=', filter.to);
  if (filter.staffId) q = q.where('a.staffId', '=', filter.staffId);
  const rows = await q.orderBy('a.date', 'desc').orderBy('s.displayName').limit(5000).execute();
  return rows.map((r) => ({
    staffId: r.staffId,
    staffName: r.staffName,
    branchId: r.branchId,
    date: r.date,
    status: r.status as AttendanceStatus,
    scheduledStart: r.scheduledStart?.toISOString() ?? null,
    scheduledEnd: r.scheduledEnd?.toISOString() ?? null,
    firstIn: r.firstIn?.toISOString() ?? null,
    lastOut: r.lastOut?.toISOString() ?? null,
    workedMinutes: r.workedMinutes,
    lateMinutes: r.lateMinutes,
    isManualOverride: r.isManualOverride,
    overrideReason: r.overrideReason,
  }));
}

// ───────────── Punch ingestion ─────────────
export async function ingestPunches(
  tx: Tx,
  orgId: string,
  integration: { id: string | null; branchId: string | null },
  punches: RawPunch[],
  source: 'biometric_pull' | 'biometric_push' | 'manual' | 'import',
): Promise<{ received: number; inserted: number; unmapped: number }> {
  if (!punches.length) return { received: 0, inserted: 0, unmapped: 0 };
  const punchIds = [...new Set(punches.map((p) => p.punchId))];
  const staffRows = await tx.selectFrom('staff').select(['id', 'branchId', 'biometricPunchId']).where('organizationId', '=', orgId).where('biometricPunchId', 'in', punchIds).execute();
  const byPunch = new Map(staffRows.map((s) => [s.biometricPunchId!, s]));
  let inserted = 0;
  for (let i = 0; i < punches.length; i += 500) {
    const chunk = punches.slice(i, i + 500);
    const res = await tx
      .insertInto('attendancePunches')
      .values(
        chunk.map((p) => {
          const staff = byPunch.get(p.punchId);
          return {
            organizationId: orgId,
            branchId: staff?.branchId ?? integration.branchId,
            integrationId: integration.id,
            staffId: staff?.id ?? null,
            punchId: p.punchId,
            punchedAt: p.punchedAt,
            direction: p.direction,
            source,
            externalId: p.externalId,
            raw: p.raw === undefined ? null : JSON.stringify(p.raw),
          };
        }),
      )
      .onConflict((oc) => oc.columns(['organizationId', 'source', 'externalId']).doNothing())
      .executeTakeFirst();
    inserted += Number(res.numInsertedOrUpdatedRows ?? 0);
  }
  return { received: punches.length, inserted, unmapped: punches.filter((p) => !byPunch.has(p.punchId)).length };
}

/** Attaches earlier unmapped punches once a staff member's punch ID is filled in. */
export async function remapUnmappedPunches(tx: Tx, orgId: string): Promise<number> {
  const res = await sql`
    update attendance_punches p set staff_id = s.id, branch_id = coalesce(p.branch_id, s.branch_id)
      from staff s
     where p.organization_id = ${orgId} and p.staff_id is null and s.organization_id = p.organization_id and s.biometric_punch_id = p.punch_id`.execute(tx);
  return Number(res.numAffectedRows ?? 0);
}

export interface SyncOutcome {
  integrationId: string;
  displayName: string;
  ok: boolean;
  received: number;
  inserted: number;
  unmapped: number;
  error?: string;
}

/**
 * Pulls punches for one connection. Failure is contained: the error is stored on the connection and returned, and
 * nothing else in the application is affected (bookings, billing and the calendar keep working).
 */
export async function syncIntegration(integrationId: string): Promise<SyncOutcome> {
  const integration = await withSystem((tx) =>
    tx.selectFrom('organizationIntegrations').selectAll().where('id', '=', integrationId).executeTakeFirst(),
  );
  if (!integration) return { integrationId, displayName: '', ok: false, received: 0, inserted: 0, unmapped: 0, error: 'Connection not found' };
  const base = { integrationId, displayName: integration.displayName };
  try {
    const secrets = integration.secretsEncrypted ? (JSON.parse(decryptSecret(integration.secretsEncrypted)) as Record<string, string>) : {};
    const provider = buildBiometricProvider(integration.provider, (integration.config ?? {}) as Record<string, string | number | boolean>, secrets);
    if (!provider) return { ...base, ok: true, received: 0, inserted: 0, unmapped: 0 };
    const to = new Date();
    const from = new Date((integration.lastSuccessAt ?? new Date(to.getTime() - 3 * 86400_000)).getTime() - 60 * MINUTE);
    const punches = await provider.fetchPunches({ from, to });
    const result = await withSystem(async (tx) => {
      const r = await ingestPunches(tx, integration.organizationId, { id: integration.id, branchId: integration.branchId }, punches, 'biometric_pull');
      await tx.updateTable('organizationIntegrations').set({ lastSyncAt: to, lastSuccessAt: to, lastError: null, lastErrorAt: null, status: 'active' }).where('id', '=', integration.id).execute();
      return r;
    });
    return { ...base, ok: true, ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    metrics.integrationFailures.inc({ kind: 'biometric' });
    logger.warn({ integrationId, reason: message }, 'biometric sync failed');
    await withSystem((tx) =>
      tx.updateTable('organizationIntegrations').set({ lastSyncAt: new Date(), lastError: message.slice(0, 500), lastErrorAt: new Date(), status: 'error' }).where('id', '=', integrationId).execute(),
    ).catch(() => undefined);
    return { ...base, ok: false, received: 0, inserted: 0, unmapped: 0, error: message };
  }
}
