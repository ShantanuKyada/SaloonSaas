import { describe, expect, it } from 'vitest';
import { checkBooking, computeAvailability, mergeIntervals, subtractIntervals, type EngineInput, type StaffDay } from './engine.js';

const MIN = 60_000;
const H = 60 * MIN;
// Arbitrary fixed "day": midnight = 0; times are expressed as hours offset for readability.
const at = (hours: number) => Math.round(hours * H);
const fmt = (ms: number) => {
  const total = Math.round(ms / MIN);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};

function staff(overrides: Partial<StaffDay> = {}): StaffDay {
  return {
    staffId: 's1',
    displayName: 'Rahul',
    color: '#000',
    qualified: true,
    bookable: true,
    durationMinutes: 60,
    price: 120000,
    working: [{ start: at(10), end: at(19) }],
    breaks: [],
    leave: { full: false, intervals: [] },
    blocks: [],
    busy: [],
    isPreferred: false,
    ...overrides,
  };
}

function input(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    branchOpen: { start: at(9), end: at(20) },
    holiday: null,
    now: at(0),
    minNoticeMinutes: 0,
    slotIntervalMinutes: 30,
    bufferMinutes: 0,
    allowOutsideHours: false,
    staff: [staff()],
    formatTime: fmt,
    ...overrides,
  };
}

describe('interval helpers', () => {
  it('merges overlapping and touching intervals', () => {
    expect(mergeIntervals([{ start: 5, end: 8 }, { start: 1, end: 3 }, { start: 3, end: 4 }, { start: 7, end: 9 }])).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 9 },
    ]);
  });
  it('subtracts intervals', () => {
    expect(subtractIntervals([{ start: 0, end: 10 }], [{ start: 3, end: 5 }])).toEqual([
      { start: 0, end: 3 },
      { start: 5, end: 10 },
    ]);
  });
});

describe('computeAvailability', () => {
  it('offers slots within the shift and never past closing time', () => {
    const r = computeAvailability(input());
    const slots = r.staff[0]!.slots;
    expect(slots[0]).toBe(at(10));
    expect(slots[slots.length - 1]).toBe(at(18)); // 60 min service must end by 19:00
    expect(r.staff[0]!.state).toBe('available');
  });

  it('intersects staff hours with branch hours', () => {
    const r = computeAvailability(input({ branchOpen: { start: at(11), end: at(17) } }));
    expect(r.staff[0]!.slots[0]).toBe(at(11));
    expect(r.staff[0]!.slots.at(-1)).toBe(at(16));
  });

  it('removes slots that collide with an existing booking', () => {
    const r = computeAvailability(input({ staff: [staff({ busy: [{ start: at(11), end: at(12.5) }] })] }));
    const slots = r.staff[0]!.slots;
    expect(slots).not.toContain(at(10.5)); // 10:30–11:30 overlaps
    expect(slots).not.toContain(at(11));
    expect(slots).not.toContain(at(12));
    expect(slots).toContain(at(10));
    expect(slots).toContain(at(12.5));
  });

  it('respects buffer time after a service', () => {
    const r = computeAvailability(input({ bufferMinutes: 30, staff: [staff({ busy: [{ start: at(12), end: at(13) }] })] }));
    // 60-min service + 30-min buffer: starting 11:00 would occupy 11:00–12:30 and collide with the 12:00 booking,
    // but starting 10:30 occupies 10:30–12:00, which only touches it (back-to-back is allowed).
    expect(r.staff[0]!.slots).not.toContain(at(11));
    expect(r.staff[0]!.slots).not.toContain(at(11.5));
    expect(r.staff[0]!.slots).toContain(at(10.5));
    expect(r.staff[0]!.slots).toContain(at(10));
  });

  it('skips breaks', () => {
    const r = computeAvailability(input({ staff: [staff({ breaks: [{ start: at(13), end: at(14), label: 'Lunch' }] })] }));
    const slots = r.staff[0]!.slots;
    expect(slots).not.toContain(at(13));
    expect(slots).not.toContain(at(12.5));
    expect(slots).toContain(at(14));
    expect(slots).toContain(at(12));
  });

  it('reports leave and day-off clearly', () => {
    const onLeave = computeAvailability(input({ staff: [staff({ leave: { full: true, intervals: [] } })] }));
    expect(onLeave.staff[0]!.state).toBe('on_leave');
    expect(onLeave.staff[0]!.slots).toEqual([]);
    const off = computeAvailability(input({ staff: [staff({ working: [] })] }));
    expect(off.staff[0]!.state).toBe('not_working');
    expect(off.staff[0]!.label).toBe('Day off');
  });

  it('handles half-day leave', () => {
    const r = computeAvailability(input({ staff: [staff({ leave: { full: false, intervals: [{ start: at(10), end: at(14.5) }] } })] }));
    expect(r.staff[0]!.slots[0]).toBe(at(14.5));
  });

  it('honours minimum notice and the current time', () => {
    const r = computeAvailability(input({ now: at(11.2), minNoticeMinutes: 30 }));
    expect(r.staff[0]!.slots[0]).toBe(at(12));
  });

  it('explains why a specific time is unavailable', () => {
    const busy = computeAvailability(input({ requestedStart: at(11), staff: [staff({ busy: [{ start: at(10.5), end: at(12) }] })] }));
    expect(busy.staff[0]!.state).toBe('busy');
    expect(busy.staff[0]!.label).toBe('Busy until 12:00 PM');
    const ok = computeAvailability(input({ requestedStart: at(15) }));
    expect(ok.staff[0]!.state).toBe('available');
  });

  it('closed branch or holiday yields no slots', () => {
    const r = computeAvailability(input({ branchOpen: null, holiday: 'Diwali' }));
    expect(r.staff[0]!.slots).toEqual([]);
    expect(r.staff[0]!.label).toContain('Diwali');
  });

  it('allows outside-hours booking only when explicitly enabled', () => {
    const closed = computeAvailability(input({ branchOpen: null, allowOutsideHours: true }));
    expect(closed.staff[0]!.slots.length).toBeGreaterThan(0);
  });

  it('puts preferred staff first and aggregates slots across staff', () => {
    const r = computeAvailability(
      input({
        staff: [staff({ staffId: 'a', displayName: 'Amit' }), staff({ staffId: 'b', displayName: 'Rahul', isPreferred: true, busy: [{ start: at(10), end: at(11) }] })],
      }),
    );
    expect(r.staff[0]!.staffId).toBe('b');
    const ten = r.slots.find((s) => s.startAt === at(10))!;
    expect(ten.staffIds).toEqual(['a']);
    const noon = r.slots.find((s) => s.startAt === at(12))!;
    expect(noon.staffIds.sort()).toEqual(['a', 'b']);
  });
});

describe('checkBooking', () => {
  const base = {
    staff: staff(),
    start: at(11),
    durationMinutes: 60,
    bufferMinutes: 0,
    branchOpen: { start: at(9), end: at(20) },
    holiday: null,
    now: at(0),
    allowOutsideHours: false,
    allowPast: false,
    formatTime: fmt,
    formatDate: () => 'Friday, 23 Oct',
  };

  it('accepts a valid booking', () => {
    expect(checkBooking(base)).toBeNull();
  });

  it('rejects double booking with a human message', () => {
    const problem = checkBooking({ ...base, staff: staff({ busy: [{ start: at(10.5), end: at(11.5) }] }) });
    expect(problem?.code).toBe('APPOINTMENT_CONFLICT');
    expect(problem?.message).toContain('already booked');
  });

  it('allows back-to-back bookings', () => {
    expect(checkBooking({ ...base, staff: staff({ busy: [{ start: at(10), end: at(11) }] }) })).toBeNull();
  });

  it('rejects unqualified staff', () => {
    expect(checkBooking({ ...base, staff: staff({ qualified: false }) })?.code).toBe('STAFF_NOT_QUALIFIED');
  });

  it('rejects leave', () => {
    expect(checkBooking({ ...base, staff: staff({ leave: { full: true, intervals: [] } }) })?.code).toBe('STAFF_ON_LEAVE');
  });

  it('rejects outside branch hours unless overridden', () => {
    expect(checkBooking({ ...base, start: at(19.5) })?.code).toBe('OUTSIDE_WORKING_HOURS');
    expect(checkBooking({ ...base, start: at(19.5), allowOutsideHours: true })).toBeNull();
  });

  it('rejects staff outside their shift', () => {
    const problem = checkBooking({ ...base, start: at(9.5), staff: staff({ working: [{ start: at(10), end: at(19) }] }) });
    expect(problem?.code).toBe('OUTSIDE_WORKING_HOURS');
  });

  it('rejects closed days and past times', () => {
    expect(checkBooking({ ...base, branchOpen: null, holiday: 'Diwali' })?.code).toBe('BRANCH_CLOSED');
    expect(checkBooking({ ...base, now: at(12) })?.code).toBe('BOOKING_IN_PAST');
    expect(checkBooking({ ...base, now: at(12), allowPast: true })).toBeNull();
  });

  it('includes buffer when checking collisions', () => {
    const s = staff({ busy: [{ start: at(12), end: at(13) }] });
    expect(checkBooking({ ...base, staff: s, bufferMinutes: 0 })).toBeNull();
    expect(checkBooking({ ...base, staff: s, bufferMinutes: 15 })?.code).toBe('APPOINTMENT_CONFLICT');
  });
});
