import {
  auctionBatchQuerySchema,
  auctionConsumedSchemas,
  auctionCreateRequestSchema,
  auctionEventSchemas,
  auctionMemberSchema,
  auctionPageSchema,
  auctionPublicSchema,
  auctionsResponseSchema,
  bidHistoryPageSchema,
  bidRequestSchema,
  bidResultSchema,
  myBidSchema,
  type AuctionEventType,
} from '@marketplace-sandbox/contracts';

const id = '0192f3a0-0000-7000-8000-000000000001';
const shop = '0192f3a0-0000-7000-8000-000000000002';
const product = '0192f3a0-0000-7000-8000-000000000003';
const user = '0192f3a0-0000-7000-8000-000000000004';
const other = '0192f3a0-0000-7000-8000-000000000005';
const order = '0192f3a0-0000-7000-8000-000000000006';
const t0 = '2030-01-01T10:00:00.000Z';
const t1 = '2030-01-01T11:00:00.000Z';

const pub = {
  auctionId: id,
  productId: product,
  shopId: shop,
  title: 'Signed #001/100',
  currency: 'EUR',
  status: 'OPEN',
  startsAt: t0,
  endsAt: t1,
  priceMinor: 11500,
  minimumNextMaxMinor: 12000,
  bidCount: 4,
  hasReserve: false,
  reserveMet: false,
  leaderAlias: 'Bidder 7K2Q4M',
  version: 4,
  serverTime: t0,
};

describe('S21 contracts: HTTP schemas', () => {
  it('S21 AS-43: the public body parses and holds no user id, maximum or reserve amount', () => {
    expect(auctionPublicSchema.parse(pub)).toEqual(pub);
    expect(auctionsResponseSchema.parse([pub])).toHaveLength(1);
    for (const leak of [
      { leaderId: user },
      { leaderMaxMinor: 12000 },
      { reservePriceMinor: 3000 },
      { maxAmountMinor: 12000 },
    ])
      expect(auctionPublicSchema.safeParse({ ...pub, ...leak }).success).toBe(
        false,
      );
  });

  it('S21 AS-07: the seller view carries the reserve and no bidder id', () => {
    const member = {
      id,
      shopId: shop,
      productId: product,
      title: 'x',
      currency: 'EUR',
      startingPriceMinor: 1000,
      minIncrementMinor: 500,
      reservePriceMinor: 3000,
      startsAt: t0,
      endsAt: t1,
      originalEndsAt: t1,
      status: 'SCHEDULED',
      statusReason: null,
      priceMinor: 1000,
      bidCount: 0,
      leaderAlias: null,
      reserveMet: false,
      winnerOrderId: null,
      finalPriceMinor: null,
      version: 1,
      createdAt: t0,
    };
    expect(auctionMemberSchema.parse(member)).toEqual(member);
    expect(
      auctionPageSchema.parse({ items: [member], nextCursor: null }).items,
    ).toHaveLength(1);
    expect(
      auctionMemberSchema.safeParse({ ...member, leaderId: user }).success,
    ).toBe(false);
  });

  it('S21 AS-02: the create body is strict and bounded', () => {
    const ok = {
      productId: product,
      title: 'Signed #001/100',
      startingPriceMinor: 1000,
      minIncrementMinor: 500,
      reservePriceMinor: 3000,
      startsAt: t0,
      endsAt: t1,
    };
    expect(auctionCreateRequestSchema.safeParse(ok).success).toBe(true);
    expect(
      auctionCreateRequestSchema.safeParse({
        ...ok,
        reservePriceMinor: undefined,
      }).success,
    ).toBe(true);
    for (const bad of [
      { title: '' },
      { title: 'x'.repeat(141) },
      { startingPriceMinor: 0 },
      { startingPriceMinor: -1 },
      { minIncrementMinor: 1.5 },
      { reservePriceMinor: '3000' },
      { startingPriceMinor: 1_000_000_000_001 },
      { startsAt: 'tomorrow' },
      { endsAt: '2030-13-01' },
      { productId: 'nope' },
      { buyNowMinor: 5000 },
    ])
      expect(
        auctionCreateRequestSchema.safeParse({ ...ok, ...bad }).success,
      ).toBe(false);
  });

  it('S21 AS-16: the bid body is strict', () => {
    expect(bidRequestSchema.safeParse({ maxAmountMinor: 10000 }).success).toBe(
      true,
    );
    expect(
      bidRequestSchema.safeParse({ maxAmountMinor: 1_000_000_000_000 }).success,
    ).toBe(true);
    for (const bad of [
      {},
      { maxAmountMinor: 0 },
      { maxAmountMinor: -5 },
      { maxAmountMinor: 1.5 },
      { maxAmountMinor: '100' },
      { maxAmountMinor: 1_000_000_000_001 },
      { maxAmountMinor: 100, clientTime: t0 },
    ])
      expect(bidRequestSchema.safeParse(bad).success).toBe(false);
  });

  it('S21 AS-10: bid result, history page and my-bid', () => {
    expect(
      bidResultSchema.safeParse({
        outcome: 'leading',
        priceMinor: 1000,
        youAreLeading: true,
        leaderAlias: 'Bidder 7K2Q4M',
        endsAt: t1,
        version: 1,
        serverTime: t0,
        minimumNextMaxMinor: 1500,
        reserveMet: false,
        hasReserve: false,
      }).success,
    ).toBe(true);
    expect(
      bidHistoryPageSchema.safeParse({
        items: [
          {
            sequence: 4,
            priceMinor: 11500,
            outcome: 'outbid',
            bidderAlias: 'Bidder AAAAAA',
            placedAt: t0,
          },
        ],
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(
      bidHistoryPageSchema.safeParse({
        items: [
          {
            sequence: 4,
            priceMinor: 11500,
            outcome: 'raised',
            bidderAlias: 'Bidder AAAAAA',
            placedAt: t0,
          },
        ],
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      myBidSchema.safeParse({
        maxAmountMinor: null,
        isLeading: false,
        priceMinor: 1000,
      }).success,
    ).toBe(true);
  });

  it('S21 AS-44: the batch query accepts up to 100 distinct ids', () => {
    const ids = Array.from(
      { length: 100 },
      (_, i) => `0192f3a0-0000-7000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(
      auctionBatchQuerySchema.parse({ productIds: ids.join(',') }).productIds,
    ).toHaveLength(100);
    expect(
      auctionBatchQuerySchema.parse({ productIds: `${product},${product}` })
        .productIds,
    ).toEqual([product]);
    expect(
      auctionBatchQuerySchema.safeParse({
        productIds: [...ids, product].join(','),
      }).success,
    ).toBe(false);
    expect(
      auctionBatchQuerySchema.safeParse({ productIds: 'not-a-uuid' }).success,
    ).toBe(false);
  });
});

describe('S21 contracts: event payloads', () => {
  const common = {
    auctionId: id,
    shopId: shop,
    productId: product,
    auctionVersion: 3,
  };
  const payloads: Record<AuctionEventType, Record<string, unknown>> = {
    'auction.created': { ...common, startsAt: t0, endsAt: t1, currency: 'EUR' },
    'auction.opened': { ...common, endsAt: t1 },
    'auction.bid_placed': {
      ...common,
      bidderId: user,
      outcome: 'leading',
      priceMinor: 1000,
      currency: 'EUR',
      leaderId: user,
      endsAt: t1,
      extended: false,
      sequence: 1,
    },
    'auction.leader_changed': {
      ...common,
      previousLeaderId: user,
      leaderId: other,
      priceMinor: 10500,
      currency: 'EUR',
    },
    'auction.closed': {
      ...common,
      status: 'CLOSED',
      winnerId: user,
      finalPriceMinor: 3000,
      currency: 'EUR',
      reserveMet: true,
      reason: 'winner',
    },
    'auction.second_chance_offered': {
      ...common,
      offeredToId: other,
      priceMinor: 5000,
      currency: 'EUR',
      expiresAt: t1,
    },
    'auction.sold': {
      ...common,
      buyerId: user,
      finalPriceMinor: 3000,
      currency: 'EUR',
      orderId: order,
      viaSecondChance: false,
    },
    'auction.unsold': { ...common, reason: 'winner_unpaid' },
    'auction.cancelled': { ...common, reason: 'seller_cancelled' },
  };

  it.each(Object.entries(payloads))('S21 AS-49: %s parses', (type, payload) => {
    expect(
      auctionEventSchemas[type as AuctionEventType].safeParse(payload).success,
    ).toBe(true);
  });

  it('S21 AS-49: every event type has a payload in this table', () => {
    expect(Object.keys(payloads).sort()).toEqual(
      Object.keys(auctionEventSchemas).sort(),
    );
  });

  it("S21 AS-49: the events S28 consumes parse with S28's own schemas", () => {
    for (const type of Object.keys(
      auctionConsumedSchemas,
    ) as (keyof typeof auctionConsumedSchemas)[]) {
      const parsed = auctionConsumedSchemas[type].safeParse(payloads[type]);
      expect(parsed.success).toBe(true);
    }
  });

  it('S21 AS-49: a payload never carries a maximum or the reserve amount', () => {
    for (const payload of Object.values(payloads)) {
      const keys = JSON.stringify(payload);
      expect(keys).not.toMatch(/maxAmount|leaderMax|reservePrice/);
    }
    for (const schema of Object.values(auctionEventSchemas))
      expect(Object.keys(schema.shape).join()).not.toMatch(
        /maxAmount|leaderMax|reservePrice/,
      );
  });
});
