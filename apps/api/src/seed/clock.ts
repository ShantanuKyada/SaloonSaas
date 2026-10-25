import { DateTime } from 'luxon';

// Seed-only time machine. The seed drives the real API to create history, so the business rules (no booking in the
// past, bills dated "today", etc.) must see the historical moment. Fake time = real time + a constant offset, so
// events created in sequence keep their order.

const RealDate = Date;
let offset = 0;

class FakeDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + offset);
    else super(...(args as [number]));
  }
  static override now(): number {
    return RealDate.now() + offset;
  }
}

export function installClock(): void {
  (globalThis as { Date: DateConstructor }).Date = FakeDate as unknown as DateConstructor;
}

export function setClock(instant: DateTime): void {
  offset = instant.toMillis() - RealDate.now();
}

export function resetClock(): void {
  offset = 0;
}

export function realNow(): Date {
  return new RealDate();
}

export function fakeNow(): DateTime {
  return DateTime.fromMillis(RealDate.now() + offset);
}

/** Runs `fn` with real time (e.g. to issue tokens whose expiry must be in the real future), then restores the fake clock. */
export async function withRealClock<T>(fn: () => Promise<T>): Promise<T> {
  const saved = offset;
  offset = 0;
  try {
    return await fn();
  } finally {
    offset = saved;
  }
}
