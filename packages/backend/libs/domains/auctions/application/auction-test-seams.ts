/**
 * Two seams inside the application services that only the test kit binds (research R-02, L-003): production binds
 * no-ops. A spec that uses one asserts it was reached, so a seam that is never hit makes the test fail instead of
 * passing hollow.
 *
 *  - `BidDecisionGate`: awaited after the bid took the auction lock and before it decides (AS-32, AS-42): the spec
 *    holds a bid inside its decision while the close is attempted.
 *  - `CrashPoint`: a named step boundary in multi-step flows (`schedule.after_row`, `settlement.before_request`,
 *    `close.after_commit`); the test double throws a `SimulatedCrash` there, as a process dying at that step would.
 */
export interface BidDecisionGate {
  /** Called inside the bid transaction after the lock, with the bid's identity. */
  hold(point: { auctionId: string; bidderId: string }): void | Promise<void>;
}

export interface CrashPoint {
  hit(name: string): void | Promise<void>;
}

/**
 * What a crash point throws: the process "died" here, so no compensation may run (a real crash runs no `catch`).
 * Code that compensates on failure rethrows this one untouched.
 */
export class SimulatedCrash extends Error {
  constructor(point: string) {
    super(`crash at ${point}`);
    this.name = 'SimulatedCrash';
  }
}

export const BID_DECISION_GATE = Symbol('AUCTION_BID_DECISION_GATE');
export const AUCTION_CRASH_POINT = Symbol('AUCTION_CRASH_POINT');

export const noGate: BidDecisionGate = { hold: () => undefined };
export const noCrash: CrashPoint = { hit: () => undefined };
