import * as fc from 'fast-check';
import {
  AUCTION_STATUSES,
  biddingDecision,
  transition,
  type AuctionCommand,
  type AuctionStatus,
} from './auction-state';
import { extendEnd, validateSchedule } from './auction-schedule';
import { bidderAlias } from './bidder-alias';
import { rankRunnersUp, selectRunnerUp } from './runner-up';

const min = 60_000;
const startsAt = new Date('2026-10-14T12:00:00.000Z');
const endsAt = new Date(startsAt.getTime() + 60 * min);
const at = (d: Date, ms: number) => new Date(d.getTime() + ms);

const open: AuctionCommand = { type: 'open' };
const cancel0: AuctionCommand = {
  type: 'cancel',
  reason: 'seller_cancelled',
  bidCount: 0,
};
const cancel2: AuctionCommand = {
  type: 'cancel',
  reason: 'seller_cancelled',
  bidCount: 2,
};
const closeWin: AuctionCommand = { type: 'close', outcome: { kind: 'winner' } };
const closeUnsold: AuctionCommand = {
  type: 'close',
  outcome: { kind: 'unsold', reason: 'no_bids' },
};
const offer: AuctionCommand = { type: 'offerSecondChance' };
const paid: AuctionCommand = { type: 'settlePaid' };
const unpaid: AuctionCommand = {
  type: 'settleUnpaid',
  reason: 'winner_unpaid',
};

type Row = [AuctionStatus, AuctionCommand, AuctionStatus | null];

describe('S21 AS-54: auction state machine', () => {
  it('S21 AS-54: every (status, command) pair', () => {
    const rows: Row[] = [
      ['SCHEDULED', open, 'OPEN'],
      ['SCHEDULED', cancel0, 'CANCELLED'],
      ['SCHEDULED', cancel2, 'CANCELLED'],
      ['SCHEDULED', closeWin, null],
      ['SCHEDULED', closeUnsold, null],
      ['SCHEDULED', offer, null],
      ['SCHEDULED', paid, null],
      ['SCHEDULED', unpaid, null],
      ['OPEN', open, null],
      ['OPEN', cancel0, 'CANCELLED'],
      ['OPEN', cancel2, null],
      ['OPEN', closeWin, 'CLOSED'],
      ['OPEN', closeUnsold, 'UNSOLD'],
      ['OPEN', offer, null],
      ['OPEN', paid, null],
      ['OPEN', unpaid, null],
      ['CLOSED', open, null],
      ['CLOSED', cancel0, null],
      ['CLOSED', cancel2, null],
      ['CLOSED', closeWin, null],
      ['CLOSED', closeUnsold, null],
      ['CLOSED', offer, 'SECOND_CHANCE'],
      ['CLOSED', paid, 'SOLD'],
      ['CLOSED', unpaid, 'UNSOLD'],
      ['SECOND_CHANCE', open, null],
      ['SECOND_CHANCE', cancel0, null],
      ['SECOND_CHANCE', cancel2, null],
      ['SECOND_CHANCE', closeWin, null],
      ['SECOND_CHANCE', closeUnsold, null],
      ['SECOND_CHANCE', offer, null],
      ['SECOND_CHANCE', paid, 'SOLD'],
      ['SECOND_CHANCE', unpaid, 'UNSOLD'],
      ...(['SOLD', 'UNSOLD', 'CANCELLED'] as const).flatMap((s): Row[] =>
        [
          open,
          cancel0,
          cancel2,
          closeWin,
          closeUnsold,
          offer,
          paid,
          unpaid,
        ].map((c) => [s, c, null] as Row),
      ),
    ];
    // every pair of the table appears exactly once
    expect(rows).toHaveLength(AUCTION_STATUSES.length * 8);
    for (const [from, command, to] of rows) {
      const r = transition(from, command);
      if (to === null)
        expect([from, command.type, r.ok]).toEqual([from, command.type, false]);
      else
        expect([from, command.type, r.ok && r.to]).toEqual([
          from,
          command.type,
          to,
        ]);
    }
  });

  it('S21 AS-54: reasons and the refusal codes of a cancel', () => {
    expect(transition('OPEN', closeUnsold)).toEqual({
      ok: true,
      to: 'UNSOLD',
      reason: 'no_bids',
    });
    expect(transition('OPEN', closeWin)).toEqual({
      ok: true,
      to: 'CLOSED',
      reason: null,
    });
    expect(transition('SCHEDULED', cancel0)).toEqual({
      ok: true,
      to: 'CANCELLED',
      reason: 'seller_cancelled',
    });
    expect(transition('CLOSED', unpaid)).toEqual({
      ok: true,
      to: 'UNSOLD',
      reason: 'winner_unpaid',
    });
    expect(transition('OPEN', cancel2)).toEqual({
      ok: false,
      code: 'auction_has_bids',
    });
    expect(transition('CLOSED', cancel0)).toEqual({
      ok: false,
      code: 'auction_not_cancellable',
    });
    expect(transition('SOLD', paid)).toEqual({ ok: false, code: 'illegal' });
  });

  describe('bidding window', () => {
    const a = (status: AuctionStatus, unitHeld = true) => ({
      status,
      unitHeld,
      startsAt,
      endsAt,
    });
    it.each<[string, AuctionStatus, Date, string]>([
      ['T - 1 s', 'SCHEDULED', at(startsAt, -1000), 'not_started'],
      ['T, open job not run yet', 'SCHEDULED', startsAt, 'accept+opens'],
      ['T, OPEN', 'OPEN', startsAt, 'accept'],
      ['endsAt - 1 ms', 'OPEN', at(endsAt, -1), 'accept'],
      ['endsAt exactly', 'OPEN', endsAt, 'closed'],
      ['after endsAt', 'OPEN', at(endsAt, 1), 'closed'],
      ['CLOSED', 'CLOSED', at(startsAt, min), 'closed'],
      ['SECOND_CHANCE', 'SECOND_CHANCE', at(startsAt, min), 'closed'],
      ['SOLD', 'SOLD', at(startsAt, min), 'closed'],
      ['UNSOLD', 'UNSOLD', at(startsAt, min), 'closed'],
      ['CANCELLED', 'CANCELLED', at(startsAt, min), 'closed'],
    ])('S21 AS-54: %s', (_n, status, now, expected) => {
      const d = biddingDecision(a(status), now);
      const label =
        d.kind === 'accept' ? (d.opens ? 'accept+opens' : 'accept') : d.kind;
      expect(label).toBe(expected);
    });

    it('S21 AS-54: a scheduled auction whose unit is not held is not biddable', () => {
      expect(biddingDecision(a('SCHEDULED', false), at(startsAt, min))).toEqual(
        {
          kind: 'not_started',
        },
      );
    });

    it('S21 AS-54: bidding is open exactly for startsAt <= now < endsAt', () => {
      fc.assert(
        fc.property(fc.integer({ min: -5000, max: 3_700_000 }), (offset) => {
          const now = at(startsAt, offset);
          const d = biddingDecision(a('OPEN'), now);
          expect(d.kind === 'accept').toBe(now >= startsAt && now < endsAt);
        }),
      );
    });
  });

  describe('extension', () => {
    const cfg = { windowMs: 2 * min, extensionMs: 2 * min, capMs: 60 * min };
    const base = { endsAt, originalEndsAt: endsAt, priceChanged: true, ...cfg };
    it.each<[string, number, boolean, number, boolean]>([
      ['E - 90 s', -90_000, true, 30_000, true],
      ['E - 121 s', -121_000, true, 0, false],
      ['E - 120 s', -120_000, true, 0, false],
      ['raised bid at E - 10 s', -10_000, false, 0, false],
    ])('S21 AS-54: %s', (_n, offset, priceChanged, delta, extended) => {
      const r = extendEnd({
        ...base,
        now: at(endsAt, offset),
        priceChanged,
      });
      expect(r.endsAt.getTime()).toBe(endsAt.getTime() + delta);
      expect(r.extended).toBe(extended);
    });

    it('S21 AS-54: the cap is exact, a later bid leaves it', () => {
      const current = at(endsAt, 59 * min + 30_000);
      const r = extendEnd({
        ...base,
        endsAt: current,
        now: at(current, -10_000),
      });
      expect(r.endsAt.getTime()).toBe(endsAt.getTime() + 60 * min);
      expect(r.extended).toBe(true);
      const again = extendEnd({
        ...base,
        endsAt: r.endsAt,
        now: at(r.endsAt, -5000),
      });
      expect(again.endsAt.getTime()).toBe(r.endsAt.getTime());
      expect(again.extended).toBe(false);
    });

    it('S21 AS-54: total extension never exceeds the cap over random sequences', () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 0, max: 400_000 }), { maxLength: 60 }),
          (gaps) => {
            let current = endsAt;
            for (const gap of gaps) {
              // a bid arrives `gap` ms before the current end (or after it: skipped, bidding is closed)
              const now = at(current, -gap);
              const r = extendEnd({ ...base, endsAt: current, now });
              expect(r.endsAt.getTime()).toBeGreaterThanOrEqual(
                current.getTime(),
              );
              expect(r.endsAt.getTime() - endsAt.getTime()).toBeLessThanOrEqual(
                60 * min,
              );
              if (current.getTime() - now.getTime() <= 2 * min)
                expect(
                  r.endsAt.getTime() === endsAt.getTime() + 60 * min ||
                    r.endsAt.getTime() - now.getTime() >= 2 * min,
                ).toBe(true);
              current = r.endsAt;
            }
          },
        ),
      );
    });
  });

  describe('schedule validation', () => {
    const now = new Date('2026-10-14T11:55:00.000Z');
    const limits = {
      minLeadMs: min,
      minDurationMs: 10 * min,
      maxDurationMs: 30 * 24 * 60 * min,
    };
    it.each<[string, Date, Date, string | null]>([
      ['ok', startsAt, endsAt, null],
      [
        'starts too soon',
        at(now, 59_000),
        at(now, 59_000 + 20 * min),
        'starts_too_soon',
      ],
      ['exactly one minute ahead', at(now, min), at(now, 11 * min), null],
      [
        '9 min 59 s',
        startsAt,
        at(startsAt, 10 * min - 1000),
        'duration_out_of_range',
      ],
      ['10 min', startsAt, at(startsAt, 10 * min), null],
      ['30 days', startsAt, at(startsAt, 30 * 24 * 60 * min), null],
      [
        '30 days + 1 s',
        startsAt,
        at(startsAt, 30 * 24 * 60 * min + 1000),
        'duration_out_of_range',
      ],
      [
        'ends before it starts',
        startsAt,
        at(startsAt, -min),
        'duration_out_of_range',
      ],
    ])('S21 AS-54: %s', (_n, s, e, code) => {
      expect(validateSchedule({ startsAt: s, endsAt: e, now, ...limits })).toBe(
        code,
      );
    });
  });

  describe('bidder alias', () => {
    const secret = 'x'.repeat(32);
    it('S21 AS-54: deterministic, differs per bidder and per auction, not the id', () => {
      const a = bidderAlias(secret, 'auction-1', 'user-1');
      expect(bidderAlias(secret, 'auction-1', 'user-1')).toBe(a);
      expect(a).toMatch(/^Bidder [0-9A-HJKMNP-TV-Z]{6}$/);
      expect(bidderAlias(secret, 'auction-1', 'user-2')).not.toBe(a);
      expect(bidderAlias(secret, 'auction-2', 'user-1')).not.toBe(a);
      expect(bidderAlias('y'.repeat(32), 'auction-1', 'user-1')).not.toBe(a);
      expect(a).not.toContain('user-1');
    });
    it('S21 AS-54: few collisions among 200 bidders of one auction', () => {
      const seen = new Set<string>();
      for (let i = 0; i < 200; i++)
        seen.add(bidderAlias(secret, 'auction-1', `u-${i}`));
      expect(seen.size).toBe(200);
    });
    it('S21 AS-54: refuses a short secret', () => {
      expect(() => bidderAlias('short', 'a', 'b')).toThrow();
    });
  });

  describe('runner-up', () => {
    const c = (bidderId: string, maxAmountMinor: number, sequence: number) => ({
      bidderId,
      maxAmountMinor,
      sequence,
    });
    const candidates = [
      c('U1', 10000, 1),
      c('U2', 5000, 2),
      c('U3', 3000, 5),
      c('U4', 5000, 3),
    ];
    it('S21 AS-54: highest maximum, ties to the earlier bid, winner excluded', () => {
      const ranked = rankRunnersUp(candidates, {
        winnerId: 'U1',
        reservePriceMinor: null,
      });
      expect(ranked.map((x) => x.bidderId)).toEqual(['U2', 'U4', 'U3']);
      expect(selectRunnerUp(ranked, new Set())?.bidderId).toBe('U2');
    });
    it('S21 AS-54: below the reserve is not eligible, a member is skipped', () => {
      const reserve = rankRunnersUp(candidates, {
        winnerId: 'U1',
        reservePriceMinor: 4000,
      });
      expect(reserve.map((x) => x.bidderId)).toEqual(['U2', 'U4']);
      expect(selectRunnerUp(reserve, new Set(['U2']))?.bidderId).toBe('U4');
      expect(selectRunnerUp(reserve, new Set(['U2', 'U4']))).toBeNull();
      expect(
        rankRunnersUp([c('U1', 10000, 1)], {
          winnerId: 'U1',
          reservePriceMinor: null,
        }),
      ).toEqual([]);
    });
    it('S21 AS-54: a lower eligible bidder is chosen when the best one is ineligible', () => {
      const ranked = rankRunnersUp(candidates, {
        winnerId: 'U1',
        reservePriceMinor: 2500,
      });
      expect(selectRunnerUp(ranked, new Set(['U2', 'U4']))?.bidderId).toBe(
        'U3',
      );
    });
  });
});
