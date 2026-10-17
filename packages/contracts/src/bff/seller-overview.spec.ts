import { sellerOverviewResponseSchema } from './seller-overview.ts';

const shopId = '0b9f6d0e-5f0e-4c43-9d3a-1c2f6a7e8b90';
const shop = {
  id: shopId,
  name: 'Lamps',
  slug: 'lamps',
  plan: 'STARTER',
  status: 'ACTIVE',
  verificationStatus: 'VERIFIED',
  payoutsEnabled: true,
  region: 'eu',
  shopVersion: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  purgeAt: null,
  myRole: 'OWNER',
  myPermissions: ['shop.read'],
};
const stats = {
  shopId,
  days: 30,
  from: '2026-09-18',
  to: '2026-10-17',
  currency: 'USD',
  summary: {
    revenueMinor: 1000,
    orders: 2,
    unitsSold: 3,
    uniqueBuyers: 2,
    refundsCount: 0,
    refundedMinor: 0,
    netRevenueMinor: 1000,
    avgOrderValueMinor: 500,
  },
  daily: [{ day: '2026-10-17', revenueMinor: 1000, orders: 2, refundedMinor: 0 }],
  topProducts: [],
};
const today = {
  day: '2026-10-17',
  totals: { orders: 1, units: 1, revenueMinor: 500 },
  series: [
    {
      minute: '2026-10-17T10:00:00.000Z',
      orders: 1,
      units: 1,
      revenueMinor: 500,
    },
  ],
};
const rank = {
  period: {
    kind: 'week',
    id: '2026-W42',
    startsAt: '2026-10-12T00:00:00.000Z',
    endsAt: '2026-10-19T00:00:00.000Z',
    closed: false,
  },
  category: null,
  rank: 3,
  of: 40,
  topPercent: 8,
  revenueMinor: 1000,
};

describe('W04 seller overview contract (parse tests)', () => {
  it('W04 B-2: a full body parses', () => {
    const body = { shop, stats, today, rank, errors: [] };
    expect(sellerOverviewResponseSchema.safeParse(body).success).toBe(true);
  });

  it('W04 B-2: a partial body with errors[] parses', () => {
    const body = {
      shop,
      stats: null,
      today,
      rank: null,
      errors: [
        { section: 'stats', code: 'UPSTREAM_TIMEOUT', retryable: true },
        { section: 'rank', code: 'UPSTREAM_UNAVAILABLE', retryable: true },
      ],
    };
    expect(sellerOverviewResponseSchema.safeParse(body).success).toBe(true);
  });

  it('W04 B-2: rank {notRanked: true} parses, other shapes do not', () => {
    const base = { shop, stats, today, errors: [] };
    expect(
      sellerOverviewResponseSchema.safeParse({
        ...base,
        rank: { notRanked: true },
      }).success,
    ).toBe(true);
    expect(
      sellerOverviewResponseSchema.safeParse({
        ...base,
        rank: { notRanked: false },
      }).success,
    ).toBe(false);
    expect(
      sellerOverviewResponseSchema.safeParse({
        ...base,
        rank: { notRanked: true, extra: 1 },
      }).success,
    ).toBe(false);
  });

  it('W04 B-2: unknown keys are rejected (top level and error entries)', () => {
    const body = { shop, stats, today, rank, errors: [] };
    expect(
      sellerOverviewResponseSchema.safeParse({ ...body, extra: 1 }).success,
    ).toBe(false);
    expect(
      sellerOverviewResponseSchema.safeParse({
        ...body,
        errors: [
          { section: 'stats', code: 'x', retryable: true, detail: 'leak' },
        ],
      }).success,
    ).toBe(false);
    expect(
      sellerOverviewResponseSchema.safeParse({
        ...body,
        errors: [{ section: 'payment', code: 'x', retryable: true }],
      }).success,
    ).toBe(false);
  });
});
