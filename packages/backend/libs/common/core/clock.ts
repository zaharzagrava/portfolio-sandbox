/**
 * Injectable time source. Domain code that depends on "now" (hold expiry,
 * auction end, billing periods) takes a Clock so tests can move time
 * deterministically instead of sleeping.
 */
export abstract class Clock {
  abstract now(): Date;

  nowMs(): number {
    return this.now().getTime();
  }
}

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

export class FakeClock extends Clock {
  constructor(private current: Date = new Date('2026-01-01T00:00:00.000Z')) {
    super();
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(date: Date): void {
    this.current = new Date(date.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
