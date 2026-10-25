import type { ErrorCode, StaffAvailabilityState } from '@salon/shared';

// Pure scheduling engine: no database, no clock, no time-zone library. Everything is epoch milliseconds and the
// caller supplies a formatter for labels. This is what the unit tests exercise exhaustively.

export interface Interval {
  start: number;
  end: number;
}

export interface StaffDay {
  staffId: string;
  displayName: string;
  color: string;
  qualified: boolean;
  bookable: boolean;
  /** Total minutes this person needs for the requested service sequence. */
  durationMinutes: number;
  price: number;
  /** Working windows for the day (shift or one-day override). Empty = not working. */
  working: Interval[];
  breaks: Array<Interval & { label: string }>;
  /** Approved leave. `full` means the whole day. */
  leave: { full: boolean; intervals: Interval[] };
  blocks: Array<Interval & { reason: string }>;
  /** Existing bookings: [start, blockedUntil). */
  busy: Interval[];
  isPreferred: boolean;
}

export interface EngineInput {
  /** Branch opening window for the day; null when closed (weekly off or holiday). */
  branchOpen: Interval | null;
  holiday: string | null;
  now: number;
  minNoticeMinutes: number;
  slotIntervalMinutes: number;
  bufferMinutes: number;
  /** Ignore branch/shift hours (manager override); leave and double-booking are still enforced. */
  allowOutsideHours: boolean;
  staff: StaffDay[];
  /** When set, answer "who can take a booking starting at this instant?". */
  requestedStart?: number;
  formatTime: (ms: number) => string;
}

export interface StaffResult {
  staffId: string;
  displayName: string;
  color: string;
  state: StaffAvailabilityState;
  label: string;
  nextFreeAt: number | null;
  isPreferred: boolean;
  slots: number[];
  durationMinutes: number;
  price: number;
}

const MINUTE = 60_000;

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

function contains(outer: Interval, inner: Interval): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/** Merges overlapping/touching intervals; output sorted. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

/** a minus every interval in b. */
export function subtractIntervals(a: Interval[], b: Interval[]): Interval[] {
  const cuts = mergeIntervals(b);
  const out: Interval[] = [];
  for (const base of mergeIntervals(a)) {
    let pieces: Interval[] = [base];
    for (const cut of cuts) {
      pieces = pieces.flatMap((p) => {
        if (!overlaps(p, cut)) return [p];
        const res: Interval[] = [];
        if (cut.start > p.start) res.push({ start: p.start, end: cut.start });
        if (cut.end < p.end) res.push({ start: cut.end, end: p.end });
        return res;
      });
    }
    out.push(...pieces);
  }
  return out;
}

export function intersectIntervals(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of mergeIntervals(a)) {
    for (const y of mergeIntervals(b)) {
      const start = Math.max(x.start, y.start);
      const end = Math.min(x.end, y.end);
      if (end > start) out.push({ start, end });
    }
  }
  return mergeIntervals(out);
}

/** Working time after applying branch hours (unless overridden), breaks and partial leave. */
function effectiveWorking(staff: StaffDay, input: EngineInput): Interval[] {
  let working = staff.working;
  if (!input.allowOutsideHours) {
    working = input.branchOpen ? intersectIntervals(working, [input.branchOpen]) : [];
  }
  return subtractIntervals(working, [...staff.breaks, ...staff.leave.intervals]);
}

function slotCandidates(staff: StaffDay, input: EngineInput): number[] {
  const step = input.slotIntervalMinutes * MINUTE;
  const duration = staff.durationMinutes * MINUTE;
  const buffer = input.bufferMinutes * MINUTE;
  const earliest = input.now + input.minNoticeMinutes * MINUTE;
  const windows = input.allowOutsideHours && staff.working.length === 0 ? [] : effectiveWorking(staff, input);
  const taken = mergeIntervals([...staff.busy, ...staff.blocks]);
  const slots: number[] = [];
  for (const w of windows) {
    // Align to the slot grid relative to the window start (e.g. 10:00, 10:15, ...).
    for (let t = w.start; t + duration <= w.end; t += step) {
      if (t < earliest) continue;
      const blocked = { start: t, end: t + duration + buffer };
      if (taken.some((x) => overlaps(x, blocked))) continue;
      slots.push(t);
    }
  }
  return slots;
}

export function computeAvailability(input: EngineInput): { staff: StaffResult[]; slots: Array<{ startAt: number; staffIds: string[] }> } {
  const results: StaffResult[] = input.staff.map((staff) => {
    const base = {
      staffId: staff.staffId,
      displayName: staff.displayName,
      color: staff.color,
      isPreferred: staff.isPreferred,
      durationMinutes: staff.durationMinutes,
      price: staff.price,
    };
    if (!staff.qualified) return { ...base, state: 'not_qualified', label: 'Not trained for this service', nextFreeAt: null, slots: [] };
    if (!staff.bookable) return { ...base, state: 'not_working', label: 'Not taking bookings', nextFreeAt: null, slots: [] };
    if (staff.leave.full) return { ...base, state: 'on_leave', label: 'On leave', nextFreeAt: null, slots: [] };
    if (staff.working.length === 0 && !input.allowOutsideHours) return { ...base, state: 'not_working', label: 'Day off', nextFreeAt: null, slots: [] };
    if (!input.branchOpen && !input.allowOutsideHours) {
      return { ...base, state: 'not_working', label: input.holiday ? `Salon closed (${input.holiday})` : 'Salon closed', nextFreeAt: null, slots: [] };
    }

    const slots = slotCandidates(staff, input);
    if (input.requestedStart === undefined) {
      if (slots.length === 0) return { ...base, state: 'busy', label: 'Fully booked', nextFreeAt: null, slots };
      const first = slots[0]!;
      const label = first <= input.now + input.slotIntervalMinutes * MINUTE ? 'Available now' : `Free from ${input.formatTime(first)}`;
      return { ...base, state: 'available', label, nextFreeAt: first, slots };
    }

    const at = input.requestedStart;
    const nextFreeAt = slots.find((s) => s >= at) ?? null;
    if (slots.includes(at)) return { ...base, state: 'available', label: 'Available', nextFreeAt: at, slots };
    // Explain why not, in the order a receptionist would care about.
    const need: Interval = { start: at, end: at + staff.durationMinutes * MINUTE };
    const partialLeave = staff.leave.intervals.find((i) => overlaps(i, need));
    if (partialLeave) return { ...base, state: 'on_leave', label: `On leave until ${input.formatTime(partialLeave.end)}`, nextFreeAt, slots };
    const block = staff.blocks.find((b) => overlaps(b, need));
    if (block) return { ...base, state: 'blocked', label: `${block.reason} until ${input.formatTime(block.end)}`, nextFreeAt, slots };
    const withBuffer: Interval = { start: at, end: need.end + input.bufferMinutes * MINUTE };
    const clash = mergeIntervals(staff.busy).find((b) => overlaps(b, withBuffer));
    if (clash) return { ...base, state: 'busy', label: `Busy until ${input.formatTime(clash.end)}`, nextFreeAt, slots };
    const brk = staff.breaks.find((b) => overlaps(b, need));
    if (brk) return { ...base, state: 'busy', label: `${brk.label} until ${input.formatTime(brk.end)}`, nextFreeAt, slots };
    if (at < input.now + input.minNoticeMinutes * MINUTE) return { ...base, state: 'outside_hours', label: 'Too soon to book', nextFreeAt, slots };
    const windows = effectiveWorking(staff, input);
    if (!windows.some((w) => contains(w, need))) {
      const hours = mergeIntervals(staff.working);
      const label = hours.length ? `Works ${hours.map((h) => `${input.formatTime(h.start)}–${input.formatTime(h.end)}`).join(', ')}` : 'Not working';
      return { ...base, state: 'outside_hours', label, nextFreeAt, slots };
    }
    return { ...base, state: 'busy', label: nextFreeAt ? `Free at ${input.formatTime(nextFreeAt)}` : 'Not available', nextFreeAt, slots };
  });

  // Preferred staff first, then available, then by name — the order the booking screen shows.
  const rank: Record<StaffAvailabilityState, number> = { available: 0, busy: 1, blocked: 2, outside_hours: 3, on_leave: 4, not_working: 5, not_qualified: 6 };
  results.sort((a, b) => Number(b.isPreferred) - Number(a.isPreferred) || rank[a.state] - rank[b.state] || a.displayName.localeCompare(b.displayName));

  const slotMap = new Map<number, string[]>();
  for (const r of results) for (const s of r.slots) slotMap.set(s, [...(slotMap.get(s) ?? []), r.staffId]);
  const slots = [...slotMap.entries()].sort((a, b) => a[0] - b[0]).map(([startAt, staffIds]) => ({ startAt, staffIds }));
  return { staff: results, slots };
}

export interface BookingCheck {
  staff: StaffDay;
  start: number;
  durationMinutes: number;
  bufferMinutes: number;
  branchOpen: Interval | null;
  holiday: string | null;
  now: number;
  allowOutsideHours: boolean;
  allowPast: boolean;
  formatTime: (ms: number) => string;
  formatDate: (ms: number) => string;
}

export interface BookingProblem {
  code: ErrorCode;
  message: string;
}

/** Validates one service line against every scheduling rule. Returns null when the booking is allowed. */
export function checkBooking(c: BookingCheck): BookingProblem | null {
  const s = c.staff;
  const need: Interval = { start: c.start, end: c.start + c.durationMinutes * MINUTE };
  const blocked: Interval = { start: need.start, end: need.end + c.bufferMinutes * MINUTE };
  if (!s.qualified) return { code: 'STAFF_NOT_QUALIFIED', message: `${s.displayName} is not set up to perform this service. Choose another team member.` };
  if (!s.bookable) return { code: 'STAFF_UNAVAILABLE', message: `${s.displayName} is not taking bookings.` };
  if (!c.allowPast && need.start < c.now - 5 * MINUTE) return { code: 'BOOKING_IN_PAST', message: 'This time has already passed. Choose a later time.' };
  if (s.leave.full || s.leave.intervals.some((i) => overlaps(i, need))) {
    return { code: 'STAFF_ON_LEAVE', message: `${s.displayName} is on leave on ${c.formatDate(c.start)}. Choose another team member or day.` };
  }
  if (!c.allowOutsideHours) {
    if (!c.branchOpen) {
      return { code: 'BRANCH_CLOSED', message: c.holiday ? `The salon is closed on ${c.formatDate(c.start)} (${c.holiday}).` : `The salon is closed on ${c.formatDate(c.start)}.` };
    }
    if (!contains(c.branchOpen, need)) {
      return { code: 'OUTSIDE_WORKING_HOURS', message: `This is outside opening hours (${c.formatTime(c.branchOpen.start)}–${c.formatTime(c.branchOpen.end)}).` };
    }
    if (s.working.length === 0) return { code: 'STAFF_NOT_WORKING', message: `${s.displayName} is not working on ${c.formatDate(c.start)}.` };
    if (!s.working.some((w) => contains(w, need))) {
      const hours = mergeIntervals(s.working).map((h) => `${c.formatTime(h.start)}–${c.formatTime(h.end)}`).join(', ');
      return { code: 'OUTSIDE_WORKING_HOURS', message: `${s.displayName} works ${hours} that day. Choose a time within those hours.` };
    }
    const brk = s.breaks.find((b) => overlaps(b, need));
    if (brk) return { code: 'STAFF_UNAVAILABLE', message: `${s.displayName} is on ${brk.label.toLowerCase()} ${c.formatTime(brk.start)}–${c.formatTime(brk.end)}.` };
  }
  const block = s.blocks.find((b) => overlaps(b, blocked));
  if (block) return { code: 'STAFF_UNAVAILABLE', message: `${s.displayName}'s time is blocked (${block.reason}) ${c.formatTime(block.start)}–${c.formatTime(block.end)}.` };
  const clash = mergeIntervals(s.busy).find((b) => overlaps(b, blocked));
  if (clash) {
    return {
      code: 'APPOINTMENT_CONFLICT',
      message: `${s.displayName} is already booked from ${c.formatTime(clash.start)} to ${c.formatTime(clash.end)}. Choose another time or team member.`,
    };
  }
  return null;
}
