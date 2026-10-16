import { assertNever } from '@app/common/core/assert-never';
import { LaunchEventError, type LaunchEventProblemCode } from './errors';

/**
 * The hold state machine (S22 FR-033, AS-56). `CONFIRMING` is the seal: confirm claims the hold before the booking
 * transaction so expiry and takeover cannot interleave (FR-032); a failed transaction returns it to `HELD`.
 */
export const HOLD_STATES = [
  'HELD',
  'CONFIRMING',
  'CONFIRMED',
  'RELEASED',
  'EXPIRED',
] as const;
export type HoldState = (typeof HOLD_STATES)[number];

const NEXT: Record<HoldState, readonly HoldState[]> = {
  HELD: ['CONFIRMING', 'RELEASED', 'EXPIRED'],
  CONFIRMING: ['CONFIRMED', 'HELD'],
  CONFIRMED: [],
  RELEASED: [],
  EXPIRED: [],
};

export const canTransitionHold = (from: HoldState, to: HoldState) =>
  NEXT[from].includes(to);

/** The conflict code for an illegal move out of `from`. Exhaustive over the states. */
export const holdConflictCode = (from: HoldState): LaunchEventProblemCode => {
  switch (from) {
    case 'EXPIRED':
      return 'HOLD_EXPIRED';
    case 'RELEASED':
      return 'HOLD_RELEASED';
    case 'CONFIRMED':
    case 'CONFIRMING':
    case 'HELD':
      return 'HOLD_ALREADY_CONFIRMED';
    default:
      return assertNever(from, 'Unhandled hold state');
  }
};

export const assertHoldTransition = (from: HoldState, to: HoldState) => {
  if (!canTransitionHold(from, to))
    throw new LaunchEventError(holdConflictCode(from));
};

/** A hold whose end passed counts as free, whatever its stored state says (FR-017, AS-28). */
export const isLapsed = (expiresAtMs: number, nowMs: number) =>
  nowMs >= expiresAtMs;
