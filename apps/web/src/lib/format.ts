import { formatMoney } from '@salon/shared';
import { TZDate } from '@date-fns/tz';
import { addDays, format, parseISO } from 'date-fns';

// Salon time is the BRANCH's time, never the browser's: a manager travelling abroad must still see 5:00 PM as 5:00 PM.

export const money = (minor: number | null | undefined, currency = 'INR') => (minor === null || minor === undefined ? '—' : formatMoney(minor, currency));

const timeFmt = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string, key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const id = `${tz}|${key}`;
  let f = timeFmt.get(id);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...options });
    timeFmt.set(id, f);
  }
  return f;
}

const asDate = (v: string | Date) => (typeof v === 'string' ? new Date(v) : v);

/** "5:00 PM" */
export function fmtTime(value: string | Date | null | undefined, tz: string): string {
  if (!value) return '';
  const parts = formatter(tz, 'time', { hour: 'numeric', minute: '2-digit', hour12: true }).format(asDate(value));
  return parts.replace('am', 'AM').replace('pm', 'PM');
}

/** "Sat, 15 Oct" or with year */
export function fmtDay(value: string | Date | null | undefined, tz: string, withYear = false): string {
  if (!value) return '';
  const d = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : asDate(value);
  const zone = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? 'UTC' : tz;
  return formatter(zone, withYear ? 'dayY' : 'day', { weekday: 'short', day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) }).format(d);
}

export function fmtDateTime(value: string | Date | null | undefined, tz: string): string {
  if (!value) return '';
  return `${fmtDay(value, tz)}, ${fmtTime(value, tz)}`;
}

/** YYYY-MM-DD of an instant in the branch's time zone. */
export function localDate(value: string | Date, tz: string): string {
  const parts = formatter(tz, 'ymd', { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(asDate(value));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export const todayIn = (tz: string) => localDate(new Date(), tz);

/** Wall-clock date + time in a branch time zone → ISO instant. */
export function toInstant(date: string, time: string, tz: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  return new Date(new TZDate(y, m - 1, d, hh, mm, 0, tz).getTime()).toISOString();
}

/** Minutes after local midnight for an instant in a time zone. */
export function minutesOfDay(value: string | Date, tz: string): number {
  const z = new TZDate(asDate(value).getTime(), tz);
  return z.getHours() * 60 + z.getMinutes();
}

export function addDaysTo(date: string, days: number): string {
  return format(addDays(parseISO(date), days), 'yyyy-MM-dd');
}

export function startOfWeek(date: string): string {
  const d = parseISO(date);
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  return format(addDays(d, -dow), 'yyyy-MM-dd');
}

export function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function endOfMonth(date: string): string {
  const d = parseISO(`${date.slice(0, 7)}-01`);
  return format(addDays(new Date(d.getFullYear(), d.getMonth() + 1, 1), -1), 'yyyy-MM-dd');
}

export function weekdayOf(date: string): number {
  const d = parseISO(date).getDay();
  return d === 0 ? 7 : d;
}

export function daysBetweenDates(from: string, to: string): number {
  return Math.round((parseISO(to).getTime() - parseISO(from).getTime()) / 86_400_000);
}

export function relativeDays(value: string | null | undefined, now = Date.now()): string {
  if (!value) return 'Never';
  const days = Math.floor((now - new Date(value).getTime()) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 60) return '1 month ago';
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function fmtDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function fmtHours(minutes: number): string {
  return `${(minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1)} h`;
}

export function greeting(tz: string): string {
  const h = Number(formatter(tz, 'hour', { hour: 'numeric', hour12: false }).format(new Date()));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export function dateRangePreset(preset: 'today' | 'yesterday' | 'week' | 'month' | 'lastMonth', today: string): { from: string; to: string } {
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const y = addDaysTo(today, -1);
      return { from: y, to: y };
    }
    case 'week':
      return { from: startOfWeek(today), to: today };
    case 'month':
      return { from: startOfMonth(today), to: today };
    case 'lastMonth': {
      const last = addDaysTo(startOfMonth(today), -1);
      return { from: startOfMonth(last), to: last };
    }
  }
}

export const PRESET_LABELS = { today: 'Today', yesterday: 'Yesterday', week: 'This week', month: 'This month', lastMonth: 'Last month' } as const;

export function pct(part: number, whole: number): number {
  return whole ? Math.round((part / whole) * 100) : 0;
}

export function deltaPercent(value: number, previous: number | null): number | null {
  if (previous === null || previous === 0) return null;
  return Math.round(((value - previous) / previous) * 100);
}
