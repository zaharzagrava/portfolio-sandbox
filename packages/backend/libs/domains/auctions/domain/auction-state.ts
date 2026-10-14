import { assertNever } from '@app/common/core/assert-never';

/**
 * The life of an auction (S21 FR-006, FR-007; data-model §4). Pure: the clock is passed in, the repository applies a
 * result with `UPDATE … SET status = :to, version = version + 1 WHERE id AND status = :from` and asserts one row.
 *
 *   SCHEDULED ─open─▶ OPEN ─close─▶ CLOSED ─offer─▶ SECOND_CHANCE
 *       │               │   ╲          │ ╲               │ ╲
 *       │               │    ╲         │  paid─▶ SOLD ◀──┘  unpaid─▶ UNSOLD
 *       └─cancel─▶ CANCELLED ◀cancel   └─unpaid─▶ UNSOLD
 *                  (OPEN: no bids)     OPEN ─close(unsold)─▶ UNSOLD
 */

export const AUCTION_STATUSES = [
  'SCHEDULED',
  'OPEN',
  'CLOSED',
  'SECOND_CHANCE',
  'SOLD',
  'UNSOLD',
  'CANCELLED',
] as const;
export type AuctionStatus = (typeof AUCTION_STATUSES)[number];

export const TERMINAL_STATUSES: readonly AuctionStatus[] = [
  'SOLD',
  'UNSOLD',
  'CANCELLED',
];
/** A product with an auction in one of these has its unit held (FR-005). */
export const LIVE_STATUSES: readonly AuctionStatus[] = [
  'SCHEDULED',
  'OPEN',
  'CLOSED',
  'SECOND_CHANCE',
];

export const STATUS_REASONS = [
  'no_bids',
  'reserve_not_met',
  'leader_ineligible',
  'winner_unpaid',
  'second_chance_unpaid',
  'seller_cancelled',
  'stock_hold_failed',
] as const;
export type StatusReason = (typeof STATUS_REASONS)[number];

export type UnsoldAtClose = 'no_bids' | 'reserve_not_met' | 'leader_ineligible';
export type CancelReason = 'seller_cancelled' | 'stock_hold_failed';
export type UnpaidReason = 'winner_unpaid' | 'second_chance_unpaid';

export type AuctionCommand =
  | { type: 'open' }
  | { type: 'cancel'; reason: CancelReason; bidCount: number }
  | {
      type: 'close';
      outcome: { kind: 'winner' } | { kind: 'unsold'; reason: UnsoldAtClose };
    }
  | { type: 'offerSecondChance' }
  | { type: 'settlePaid' }
  | { type: 'settleUnpaid'; reason: UnpaidReason };

export type TransitionRefusal =
  'illegal' | 'auction_has_bids' | 'auction_not_cancellable';

export type Transition =
  | { ok: true; to: AuctionStatus; reason: StatusReason | null }
  | { ok: false; code: TransitionRefusal };

const to = (
  status: AuctionStatus,
  reason: StatusReason | null = null,
): Transition => ({
  ok: true,
  to: status,
  reason,
});
const ILLEGAL: Transition = { ok: false, code: 'illegal' };

export function isTerminal(status: AuctionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** The next status for a command; `ok: false` for every pair FR-007 does not allow. */
export function transition(
  from: AuctionStatus,
  command: AuctionCommand,
): Transition {
  switch (command.type) {
    case 'open':
      return from === 'SCHEDULED' ? to('OPEN') : ILLEGAL;
    case 'cancel':
      switch (from) {
        case 'SCHEDULED':
          return to('CANCELLED', command.reason);
        case 'OPEN':
          return command.bidCount === 0
            ? to('CANCELLED', command.reason)
            : { ok: false, code: 'auction_has_bids' };
        case 'CLOSED':
        case 'SECOND_CHANCE':
        case 'SOLD':
        case 'UNSOLD':
        case 'CANCELLED':
          return { ok: false, code: 'auction_not_cancellable' };
        default:
          return assertNever(from);
      }
    case 'close':
      if (from !== 'OPEN') return ILLEGAL;
      return command.outcome.kind === 'winner'
        ? to('CLOSED')
        : to('UNSOLD', command.outcome.reason);
    case 'offerSecondChance':
      return from === 'CLOSED' ? to('SECOND_CHANCE') : ILLEGAL;
    case 'settlePaid':
      return from === 'CLOSED' || from === 'SECOND_CHANCE'
        ? to('SOLD')
        : ILLEGAL;
    case 'settleUnpaid':
      return from === 'CLOSED' || from === 'SECOND_CHANCE'
        ? to('UNSOLD', command.reason)
        : ILLEGAL;
    default:
      return assertNever(command);
  }
}

export type BiddingFacts = {
  status: AuctionStatus;
  unitHeld: boolean;
  startsAt: Date;
  endsAt: Date;
};

export type BiddingDecision =
  | { kind: 'accept'; opens: boolean }
  | { kind: 'not_started' }
  | { kind: 'closed' };

/**
 * Bidding is open for `startsAt <= now < endsAt` (FR-006, FR-016). A bid at or after `startsAt` on a `SCHEDULED`
 * auction whose unit is held opens it in the same step, so the open job's timing never refuses a bid.
 */
export function biddingDecision(
  auction: BiddingFacts,
  now: Date,
): BiddingDecision {
  const t = now.getTime();
  switch (auction.status) {
    case 'SCHEDULED':
      if (t >= auction.endsAt.getTime()) return { kind: 'closed' };
      if (t < auction.startsAt.getTime() || !auction.unitHeld)
        return { kind: 'not_started' };
      return { kind: 'accept', opens: true };
    case 'OPEN':
      if (t >= auction.endsAt.getTime()) return { kind: 'closed' };
      if (t < auction.startsAt.getTime()) return { kind: 'not_started' };
      return { kind: 'accept', opens: false };
    case 'CLOSED':
    case 'SECOND_CHANCE':
    case 'SOLD':
    case 'UNSOLD':
    case 'CANCELLED':
      return { kind: 'closed' };
    default:
      return assertNever(auction.status);
  }
}
