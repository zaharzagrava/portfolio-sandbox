import * as fc from 'fast-check';
import { resolveBid, type BidState, type BidResolution } from './proxy-bid';

const base: BidState = {
  priceMinor: 1000,
  leaderId: null,
  leaderMaxMinor: null,
  minIncrementMinor: 500,
  reservePriceMinor: null,
  startingPriceMinor: 1000,
};

type Bid = [string, number];

/** Applies bids in order, returns every resolution and the final state. */
function run(
  bids: Bid[],
  initial: BidState = base,
): { results: BidResolution[]; state: BidState } {
  let state = initial;
  const results: BidResolution[] = [];
  for (const [bidderId, maxAmountMinor] of bids) {
    const r = resolveBid(state, { bidderId, maxAmountMinor });
    results.push(r);
    if (r.ok)
      state = {
        ...state,
        priceMinor: r.priceMinor,
        leaderId: r.leaderId,
        leaderMaxMinor: r.leaderMaxMinor,
      };
  }
  return { results, state };
}

describe('S21 AS-53: proxy bid resolution', () => {
  it('S21 AS-53: AS-11 four-step table', () => {
    const { results, state } = run([
      ['U1', 10000],
      ['U2', 5000],
      ['U3', 12000],
      ['U1', 10400],
      ['U1', 11000],
    ]);
    expect(results.map((r) => (r.ok ? r.outcome : r.rejection))).toEqual([
      'leading',
      'outbid',
      'leading',
      'bid_too_low',
      'outbid',
    ]);
    expect(
      results.map((r) => (r.ok ? [r.priceMinor, r.leaderId] : null)),
    ).toEqual([[1000, 'U1'], [5500, 'U1'], [10500, 'U3'], null, [11500, 'U3']]);
    const rejected = results[3];
    expect(rejected).toMatchObject({
      ok: false,
      rejection: 'bid_too_low',
      minimumMaxAmountMinor: 11000,
    });
    expect(state).toMatchObject({
      priceMinor: 11500,
      leaderId: 'U3',
      leaderMaxMinor: 12000,
    });
  });

  it('S21 AS-53: leader changes are flagged only for a real change', () => {
    const { results } = run([
      ['U1', 10000],
      ['U2', 5000],
      ['U3', 12000],
    ]);
    expect(
      results.map((r) => (r.ok ? [r.leaderChanged, r.previousLeaderId] : null)),
    ).toEqual([
      [false, null],
      [false, 'U1'],
      [true, 'U1'],
    ]);
  });

  it('S21 AS-53: AS-12 tie goes to the earlier bidder, minimum beats it', () => {
    const start: BidState = {
      ...base,
      priceMinor: 11500,
      leaderId: 'U3',
      leaderMaxMinor: 12000,
    };
    const tie = run([['U2', 12000]], start);
    expect(tie.results[0]).toMatchObject({
      ok: true,
      outcome: 'outbid',
      priceMinor: 12000,
      leaderId: 'U3',
    });
    const win = run(
      [
        ['U2', 12000],
        ['U2', 12500],
      ],
      start,
    );
    expect(win.results[1]).toMatchObject({
      ok: true,
      outcome: 'leading',
      priceMinor: 12500,
      leaderId: 'U2',
    });
    const low = run(
      [
        ['U2', 12000],
        ['U2', 12500],
        ['U3', 12999],
      ],
      start,
    );
    expect(low.results[2]).toMatchObject({
      ok: false,
      rejection: 'bid_too_low',
      minimumMaxAmountMinor: 13000,
    });
  });

  it('S21 AS-53: AS-13 reserve edges', () => {
    const reserve: BidState = { ...base, reservePriceMinor: 3000 };
    const a = run(
      [
        ['U1', 2500],
        ['U2', 4000],
      ],
      reserve,
    );
    expect(a.results[0]).toMatchObject({
      priceMinor: 1000,
      reserveMet: false,
    });
    expect(a.results[1]).toMatchObject({
      outcome: 'leading',
      priceMinor: 3000,
      reserveMet: true,
    });
    expect(run([['U1', 4000]], reserve).results[0]).toMatchObject({
      priceMinor: 3000,
      reserveMet: true,
    });
    expect(run([['U1', 2999]], reserve).results[0]).toMatchObject({
      priceMinor: 1000,
      reserveMet: false,
    });
    expect(run([['U1', 3000]], reserve).results[0]).toMatchObject({
      priceMinor: 3000,
      reserveMet: true,
    });
    expect(run([['U1', 10000]], base).results[0]).toMatchObject({
      reserveMet: false,
    });
  });

  it('S21 AS-53: AS-14 the leader raises, never lowers', () => {
    const start: BidState = {
      ...base,
      priceMinor: 12000,
      leaderId: 'U3',
      leaderMaxMinor: 12000,
    };
    const { results } = run(
      [
        ['U3', 15000],
        ['U3', 15000],
        ['U3', 14000],
      ],
      start,
    );
    expect(results[0]).toMatchObject({
      ok: true,
      outcome: 'raised',
      priceMinor: 12000,
      leaderId: 'U3',
      leaderMaxMinor: 15000,
      leaderChanged: false,
    });
    expect(results[1]).toMatchObject({
      ok: false,
      rejection: 'bid_not_increasing',
      currentMaxAmountMinor: 15000,
    });
    expect(results[2]).toMatchObject({
      ok: false,
      rejection: 'bid_not_increasing',
    });
  });

  it('S21 AS-53: a raise that reaches the reserve lifts the price to it', () => {
    const start: BidState = {
      ...base,
      reservePriceMinor: 3000,
      leaderId: 'U1',
      leaderMaxMinor: 2500,
    };
    expect(run([['U1', 3500]], start).results[0]).toMatchObject({
      outcome: 'raised',
      priceMinor: 3000,
      reserveMet: true,
    });
  });

  it.each<[string, number, number | null]>([
    ['no leader, 999', 999, 1000],
    ['no leader, 1000', 1000, null],
  ])('S21 AS-53: AS-15 first bid minimum: %s', (_n, amount, minimum) => {
    const r = resolveBid(base, { bidderId: 'U1', maxAmountMinor: amount });
    if (minimum === null)
      expect(r).toMatchObject({
        ok: true,
        outcome: 'leading',
        priceMinor: 1000,
      });
    else
      expect(r).toMatchObject({
        ok: false,
        rejection: 'bid_too_low',
        minimumMaxAmountMinor: minimum,
      });
  });

  it.each<[number, number | null]>([
    [1499, 1500],
    [1500, null],
  ])(
    'S21 AS-53: AS-15 challenger %i against a leader at 1000',
    (amount, minimum) => {
      const state: BidState = { ...base, leaderId: 'U1', leaderMaxMinor: 1000 };
      const r = resolveBid(state, { bidderId: 'U2', maxAmountMinor: amount });
      if (minimum === null)
        expect(r).toMatchObject({
          ok: true,
          outcome: 'leading',
          priceMinor: 1500,
        });
      else
        expect(r).toMatchObject({
          ok: false,
          rejection: 'bid_too_low',
          minimumMaxAmountMinor: minimum,
        });
    },
  );

  it('S21 AS-53: minimumNextMaxMinor is starting price, then price plus increment', () => {
    const first = run([['U1', 10000]]).results[0];
    expect(first).toMatchObject({ minimumNextMaxMinor: 1500 });
  });

  describe('properties', () => {
    const bids = fc.array(
      fc.tuple(
        fc.constantFrom('A', 'B', 'C', 'D', 'E'),
        fc.integer({ min: 1, max: 40 }).map((n) => n * 250),
      ),
      { minLength: 1, maxLength: 40 },
    );
    const reserves = fc.option(
      fc.integer({ min: 4, max: 30 }).map((n) => n * 250),
      { nil: null },
    );
    const increments = fc.constantFrom(250, 500, 750);

    it('S21 AS-53: price rules hold over random sequences', () => {
      fc.assert(
        fc.property(bids, reserves, increments, (sequence, reserve, inc) => {
          const initial: BidState = {
            ...base,
            minIncrementMinor: inc,
            reservePriceMinor: reserve,
          };
          let state = initial;
          const maxes = new Map<string, { max: number; seq: number }>();
          let seq = 0;
          for (const [bidderId, maxAmountMinor] of sequence) {
            const before = state;
            const minimum =
              before.leaderId === null
                ? before.startingPriceMinor
                : before.priceMinor + before.minIncrementMinor;
            const r = resolveBid(state, { bidderId, maxAmountMinor });
            if (!r.ok) {
              if (r.rejection === 'bid_too_low') {
                expect(maxAmountMinor).toBeLessThan(r.minimumMaxAmountMinor);
              } else {
                expect(bidderId).toBe(before.leaderId);
                expect(maxAmountMinor).toBeLessThanOrEqual(
                  before.leaderMaxMinor!,
                );
              }
              continue;
            }
            seq++;
            // minimums respected
            if (bidderId !== before.leaderId)
              expect(maxAmountMinor).toBeGreaterThanOrEqual(minimum);
            // the tie goes to the earlier bid at that maximum, not to the earlier bidder
            const known = maxes.get(bidderId);
            if (!known || maxAmountMinor > known.max)
              maxes.set(bidderId, { max: maxAmountMinor, seq });
            state = {
              ...state,
              priceMinor: r.priceMinor,
              leaderId: r.leaderId,
              leaderMaxMinor: r.leaderMaxMinor,
            };
            // price never decreases, never above the leader's maximum
            expect(state.priceMinor).toBeGreaterThanOrEqual(before.priceMinor);
            expect(state.priceMinor).toBeLessThanOrEqual(state.leaderMaxMinor!);
            // leader has the highest maximum, ties to the earliest bidder
            const ranked = [...maxes.entries()].sort(
              (x, y) => y[1].max - x[1].max || x[1].seq - y[1].seq,
            );
            expect(state.leaderId).toBe(ranked[0][0]);
            expect(state.leaderMaxMinor).toBe(ranked[0][1].max);
            // price = min(top, second + inc), raised to the reserve when top covers it
            // a raise of the leader's own maximum leaves the price where it was (AS-14)
            if (r.outcome === 'raised') {
              const lifted =
                reserve !== null && r.leaderMaxMinor >= reserve
                  ? Math.max(before.priceMinor, reserve)
                  : before.priceMinor;
              expect(state.priceMinor).toBe(lifted);
            } else if (ranked.length > 1) {
              let expected = Math.min(ranked[0][1].max, ranked[1][1].max + inc);
              if (reserve !== null && ranked[0][1].max >= reserve)
                expected = Math.max(expected, reserve);
              expect(state.priceMinor).toBe(expected);
            }
            expect(r.reserveMet).toBe(
              reserve !== null && state.priceMinor >= reserve,
            );
          }
        }),
        { numRuns: 300 },
      );
    });
  });
});
