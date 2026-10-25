import { sql, type RawBuilder } from 'kysely';

const DAY_MS = 86_400_000;

/**
 * Conditions selecting rows whose timestamp falls on a local calendar date in [from, to], where the local date is
 * evaluated in the time zone stored on the joined branch row. The extra coarse bounds on the raw timestamp let
 * PostgreSQL use the timestamp index; the precise check handles the time zone.
 */
export function localDateConditions(tsColumn: string, tzColumn: string, from?: string | null, to?: string | null): RawBuilder<boolean>[] {
  const ts = sql.ref(tsColumn);
  const tz = sql.ref(tzColumn);
  const out: RawBuilder<boolean>[] = [];
  if (from) {
    out.push(sql<boolean>`${ts} >= ${new Date(Date.parse(`${from}T00:00:00Z`) - DAY_MS)}`);
    out.push(sql<boolean>`(${ts} at time zone ${tz})::date >= ${from}::date`);
  }
  if (to) {
    out.push(sql<boolean>`${ts} < ${new Date(Date.parse(`${to}T00:00:00Z`) + 2 * DAY_MS)}`);
    out.push(sql<boolean>`(${ts} at time zone ${tz})::date <= ${to}::date`);
  }
  return out;
}

/** Same as localDateConditions but for a single known time zone (e.g. the organization's). */
export function localDateConditionsTz(tsColumn: string, timezone: string, from?: string | null, to?: string | null): RawBuilder<boolean>[] {
  const ts = sql.ref(tsColumn);
  const out: RawBuilder<boolean>[] = [];
  if (from) {
    out.push(sql<boolean>`${ts} >= ${new Date(Date.parse(`${from}T00:00:00Z`) - DAY_MS)}`);
    out.push(sql<boolean>`(${ts} at time zone ${timezone}::text)::date >= ${from}::date`);
  }
  if (to) {
    out.push(sql<boolean>`${ts} < ${new Date(Date.parse(`${to}T00:00:00Z`) + 2 * DAY_MS)}`);
    out.push(sql<boolean>`(${ts} at time zone ${timezone}::text)::date <= ${to}::date`);
  }
  return out;
}
