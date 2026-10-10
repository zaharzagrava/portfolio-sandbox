import { Injectable } from '@nestjs/common';

/**
 * The clock every decision uses (FR-010). Production: the store's own `TIME`, read inside the atomic script, so
 * instances with skewed system clocks still agree. Tests replace it with `ManualTimeSource` to move store time
 * deterministically instead of sleeping.
 */
export abstract class TimeSource {
  /** Milliseconds to hand to the scripts, or `null` to let them read the store's clock. */
  abstract overrideMs(): number | null;
}

@Injectable()
export class StoreTimeSource extends TimeSource {
  overrideMs(): null {
    return null;
  }
}

export class ManualTimeSource extends TimeSource {
  constructor(private ms: number) {
    super();
  }

  overrideMs(): number {
    return this.ms;
  }

  set(ms: number): void {
    this.ms = ms;
  }

  advance(ms: number): void {
    this.ms += ms;
  }
}
