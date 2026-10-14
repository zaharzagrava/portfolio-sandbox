/**
 * Proxy bidding (S21 FR-013, FR-014; data-model §5). Pure: no clock, no I/O. The caller holds the auction row lock
 * and passes the state it read; the result is what to write.
 *
 *   no leader      max >= starting          -> bidder leads at the starting price
 *   other leader   max <  price + increment -> bid_too_low
 *                  max >  leader max        -> bidder leads at min(max, leaderMax + increment)
 *                  max == leader max        -> leader keeps the lead (earlier bid) at leaderMax
 *                  max <  leader max        -> leader keeps the lead at min(leaderMax, max + increment)
 *   the leader     max <= own max           -> bid_not_increasing; else `raised`, price unchanged
 *
 * Then, when the leader's maximum covers the reserve, the price is at least the reserve.
 */

export type BidState = {
  priceMinor: number;
  leaderId: string | null;
  leaderMaxMinor: number | null;
  minIncrementMinor: number;
  reservePriceMinor: number | null;
  startingPriceMinor: number;
};

export type BidInput = { bidderId: string; maxAmountMinor: number };

export type BidOutcome = 'leading' | 'outbid' | 'raised';

export type BidResolution =
  | {
      ok: true;
      outcome: BidOutcome;
      priceMinor: number;
      leaderId: string;
      leaderMaxMinor: number;
      reserveMet: boolean;
      /** The smallest maximum a bidder who is not the leader may now place. */
      minimumNextMaxMinor: number;
      leaderChanged: boolean;
      previousLeaderId: string | null;
    }
  | { ok: false; rejection: 'bid_too_low'; minimumMaxAmountMinor: number }
  | {
      ok: false;
      rejection: 'bid_not_increasing';
      currentMaxAmountMinor: number;
    };

/** The least maximum a bidder who is not the leader may place. */
export function minimumNextMax(
  state: Pick<
    BidState,
    'leaderId' | 'priceMinor' | 'minIncrementMinor' | 'startingPriceMinor'
  >,
): number {
  return state.leaderId === null
    ? state.startingPriceMinor
    : state.priceMinor + state.minIncrementMinor;
}

export function isReserveMet(
  priceMinor: number,
  reservePriceMinor: number | null,
): boolean {
  return reservePriceMinor !== null && priceMinor >= reservePriceMinor;
}

export function resolveBid(state: BidState, bid: BidInput): BidResolution {
  const { bidderId, maxAmountMinor: max } = bid;
  const inc = state.minIncrementMinor;
  const reserve = state.reservePriceMinor;

  const accept = (
    outcome: BidOutcome,
    leaderId: string,
    leaderMaxMinor: number,
    rawPrice: number,
  ): BidResolution => {
    const priceMinor =
      reserve !== null && leaderMaxMinor >= reserve
        ? Math.max(rawPrice, reserve)
        : rawPrice;
    return {
      ok: true,
      outcome,
      priceMinor,
      leaderId,
      leaderMaxMinor,
      reserveMet: isReserveMet(priceMinor, reserve),
      minimumNextMaxMinor: priceMinor + inc,
      leaderChanged: state.leaderId !== null && leaderId !== state.leaderId,
      previousLeaderId: state.leaderId,
    };
  };

  if (state.leaderId === null || state.leaderMaxMinor === null) {
    if (max < state.startingPriceMinor)
      return {
        ok: false,
        rejection: 'bid_too_low',
        minimumMaxAmountMinor: state.startingPriceMinor,
      };
    return accept('leading', bidderId, max, state.startingPriceMinor);
  }

  const leaderMax = state.leaderMaxMinor;

  if (bidderId === state.leaderId) {
    if (max <= leaderMax)
      return {
        ok: false,
        rejection: 'bid_not_increasing',
        currentMaxAmountMinor: leaderMax,
      };
    return accept('raised', bidderId, max, state.priceMinor);
  }

  const minimum = state.priceMinor + inc;
  if (max < minimum)
    return {
      ok: false,
      rejection: 'bid_too_low',
      minimumMaxAmountMinor: minimum,
    };
  if (max > leaderMax)
    return accept('leading', bidderId, max, Math.min(max, leaderMax + inc));
  if (max === leaderMax)
    return accept('outbid', state.leaderId, leaderMax, leaderMax);
  return accept(
    'outbid',
    state.leaderId,
    leaderMax,
    Math.min(leaderMax, max + inc),
  );
}
