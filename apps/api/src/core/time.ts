import { DateTime } from 'luxon';

// All instants are UTC in the database; wall-clock times are interpreted in the branch's IANA time zone.

export function nowUtc(): DateTime {
  return DateTime.utc();
}

export function todayIn(timezone: string): string {
  return DateTime.now().setZone(timezone).toISODate()!;
}

export function localDateOf(instant: Date | string, timezone: string): string {
  const dt = typeof instant === 'string' ? DateTime.fromISO(instant, { zone: 'utc' }) : DateTime.fromJSDate(instant);
  return dt.setZone(timezone).toISODate()!;
}

/** "2026-10-23" + "10:30" in Asia/Kolkata → DateTime (DST-safe). */
export function zoned(date: string, time: string, timezone: string): DateTime {
  return DateTime.fromISO(`${date}T${time.slice(0, 5)}`, { zone: timezone });
}

/** UTC instants covering whole local days [from 00:00, to+1 00:00). */
export function localRangeToUtc(from: string, to: string, timezone: string): { start: Date; end: Date } {
  const start = DateTime.fromISO(from, { zone: timezone }).startOf('day');
  const end = DateTime.fromISO(to, { zone: timezone }).plus({ days: 1 }).startOf('day');
  return { start: start.toJSDate(), end: end.toJSDate() };
}

export function isoWeekday(date: string): number {
  return DateTime.fromISO(date).weekday;
}

export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  let cursor = DateTime.fromISO(from);
  const last = DateTime.fromISO(to);
  while (cursor <= last && out.length < 400) {
    out.push(cursor.toISODate()!);
    cursor = cursor.plus({ days: 1 });
  }
  return out;
}

export function addDays(date: string, days: number): string {
  return DateTime.fromISO(date).plus({ days }).toISODate()!;
}

export function daysBetween(fromDate: string, toDate: string): number {
  return Math.round(DateTime.fromISO(toDate).diff(DateTime.fromISO(fromDate), 'days').days);
}

export function formatLocal(instant: Date | string, timezone: string, format: string): string {
  const dt = typeof instant === 'string' ? DateTime.fromISO(instant, { zone: 'utc' }) : DateTime.fromJSDate(instant);
  return dt.setZone(timezone).toFormat(format);
}

export function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? new Date(value).toISOString() : value.toISOString();
}

/** Indian GST invoices are numbered per financial year (April–March); elsewhere per calendar year. */
export function financialPeriodKey(date: string, country: string): string {
  const dt = DateTime.fromISO(date);
  if (country === 'IN') {
    const startYear = dt.month >= 4 ? dt.year : dt.year - 1;
    return `${String(startYear % 100).padStart(2, '0')}${String((startYear + 1) % 100).padStart(2, '0')}`;
  }
  return String(dt.year);
}
