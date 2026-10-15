import { assessEligibility, blockedReason } from './eligibility';
import { planPayout } from './reserve';

const now = new Date('2026-10-05T04:00:00Z');
const earlier = new Date('2026-10-01T00:00:00Z');
const later = new Date('2026-10-06T00:00:00Z');

const ok = {
  known: true,
  status: 'ACTIVE',
  payoutsEnabled: true,
  destination: { effectiveFrom: earlier },
  now,
};

describe('eligibility gates (S15 AS-09)', () => {
  it('S15 AS-09: a known, active, enabled shop with a settled destination is eligible', () => {
    expect(assessEligibility(ok)).toEqual({ ok: true });
  });

  it.each([
    ['unknown to tenancy', { ...ok, known: false }, 'shop_unknown'],
    ['not active', { ...ok, status: 'SUSPENDED' }, 'shop_not_active'],
    ['payouts disabled', { ...ok, payoutsEnabled: false }, 'payouts_disabled'],
    ['no destination', { ...ok, destination: null }, 'destination_missing'],
    [
      'destination cooling',
      { ...ok, destination: { effectiveFrom: later } },
      'destination_cooling',
    ],
  ])('S15 AS-09: %s is skipped as %s', (_label, facts, reason) => {
    expect(assessEligibility(facts)).toEqual({ ok: false, reason });
  });

  it('S15 AS-09: gate order is reason precedence when several fail', () => {
    const all = {
      known: false,
      status: 'SUSPENDED',
      payoutsEnabled: false,
      destination: null,
      now,
    };
    expect(assessEligibility(all)).toEqual({
      ok: false,
      reason: 'shop_unknown',
    });
    expect(assessEligibility({ ...all, known: true })).toEqual({
      ok: false,
      reason: 'shop_not_active',
    });
    expect(
      assessEligibility({ ...all, known: true, status: 'ACTIVE' }),
    ).toEqual({ ok: false, reason: 'payouts_disabled' });
    expect(
      assessEligibility({
        ...all,
        known: true,
        status: 'ACTIVE',
        payoutsEnabled: true,
      }),
    ).toEqual({ ok: false, reason: 'destination_missing' });
  });

  it('S15 AS-39: the destination counts from its effective instant, inclusive', () => {
    expect(
      assessEligibility({ ...ok, destination: { effectiveFrom: now } }),
    ).toEqual({ ok: true });
    expect(
      assessEligibility({
        ...ok,
        destination: { effectiveFrom: new Date(now.getTime() + 1) },
      }),
    ).toEqual({ ok: false, reason: 'destination_cooling' });
  });
});

describe('blocking reason of the upcoming payout (S15 AS-35)', () => {
  const pay = planPayout(50_000, 1000, { minMinor: 1000, capMinor: 5_000_000 });
  const skip = planPayout(500, 1000, { minMinor: 1000, capMinor: 5_000_000 });

  it('S15 AS-35: nothing blocks a payable plan', () => {
    expect(blockedReason(ok, pay)).toBeNull();
  });

  it('S15 AS-35: a shop that is not active, unknown or disabled reports payouts_disabled', () => {
    expect(blockedReason({ ...ok, known: false }, pay)).toBe(
      'payouts_disabled',
    );
    expect(blockedReason({ ...ok, status: 'SUSPENDED' }, pay)).toBe(
      'payouts_disabled',
    );
    expect(blockedReason({ ...ok, payoutsEnabled: false }, pay)).toBe(
      'payouts_disabled',
    );
  });

  it('S15 AS-35: precedence is payouts_disabled, destination_missing, destination_cooling, below_minimum', () => {
    const none = { ...ok, payoutsEnabled: false, destination: null };
    expect(blockedReason(none, skip)).toBe('payouts_disabled');
    expect(blockedReason({ ...none, payoutsEnabled: true }, skip)).toBe(
      'destination_missing',
    );
    expect(
      blockedReason({ ...ok, destination: { effectiveFrom: later } }, skip),
    ).toBe('destination_cooling');
    expect(blockedReason(ok, skip)).toBe('below_minimum');
  });
});

describe('inclusive minimum boundary (S15 AS-06)', () => {
  const limits = { minMinor: 1000, capMinor: 5_000_000 };
  it.each([
    [999, 'skip'],
    [1000, 'pay'],
    [1001, 'pay'],
  ])('S15 AS-06: a balance of %i at 0 bps is %s', (balance, kind) => {
    expect(planPayout(balance, 0, limits).kind).toBe(kind);
  });
});
