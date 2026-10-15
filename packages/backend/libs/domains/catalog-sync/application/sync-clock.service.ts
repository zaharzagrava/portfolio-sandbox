import { Inject, Injectable } from '@nestjs/common';
import { encodeHlc, receive, tick, type Hlc } from '../domain/hlc';
import { SYNC_CLOCK, SYNC_INSTANCE, type Clock } from '../domain/ports';

/**
 * The server's hybrid logical clock (R-08, FR-022, AS-23): one per instance, node `server-<instance>`, monotonic. It
 * moves forward on every accepted device clock and on every response, so `serverHlc` is after all clocks accepted in
 * a request and never behind server time. State lives in memory on purpose: it is a clock, not a decision (the claim,
 * the feed's sequence and every operation outcome are decided in shared storage).
 */
@Injectable()
export class SyncClockService {
  private state: Hlc;

  constructor(
    @Inject(SYNC_CLOCK) private readonly clock: Clock,
    @Inject(SYNC_INSTANCE) instance: string,
  ) {
    this.state = { physical: 0, logical: 0, node: `server-${instance}` };
  }

  /** An accepted device clock: the server clock moves after it. Rejected clocks are never passed here. */
  accept(remote: Hlc): void {
    this.state = receive(this.state, remote, this.clock.now().getTime());
  }

  /** The clock to answer with: after everything accepted so far and not behind the wall clock. */
  stamp(): string {
    this.state = tick(this.state, this.clock.now().getTime());
    return encodeHlc(this.state);
  }
}
