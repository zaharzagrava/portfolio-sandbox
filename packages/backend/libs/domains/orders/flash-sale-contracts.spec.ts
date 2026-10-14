import {
  flashSaleCreateRequestSchema,
  flashSaleEventSchemas,
  flashSaleMemberSchema,
  flashSalePageSchema,
  flashSalePublicSchema,
  flashSalesResponseSchema,
} from '@marketplace-sandbox/contracts';

const id = '0192f3a0-0000-7000-8000-000000000001';
const shop = '0192f3a0-0000-7000-8000-000000000002';
const product = '0192f3a0-0000-7000-8000-000000000003';
const starts = '2030-01-01T10:00:00.000Z';
const ends = '2030-01-01T11:00:00.000Z';

const create = {
  productId: product,
  priceMinor: 49_900,
  units: 3000,
  startsAt: starts,
  endsAt: ends,
};

const member = {
  id,
  shopId: shop,
  productId: product,
  priceMinor: 49_900,
  currency: 'EUR',
  units: 3000,
  buckets: 16,
  perUserLimit: 2,
  admissionRatePerSecond: 2000,
  startsAt: starts,
  endsAt: ends,
  status: 'SCHEDULED',
  statusReason: null,
  stats: null,
  createdAt: '2029-12-31T10:00:00.000Z',
};

const publicView = {
  saleId: id,
  productId: product,
  priceMinor: 49_900,
  currency: 'EUR',
  perUserLimit: 2,
  startsAt: starts,
  endsAt: ends,
  state: 'LIVE',
  remainingApprox: 1200,
  serverTime: '2030-01-01T10:30:00.000Z',
};

describe('S11 contracts: flash-sale schemas', () => {
  describe('flashSaleCreateRequestSchema', () => {
    it('S11 AS-14: applies the defaults buckets 16, perUserLimit 2, rate 2000', () => {
      const parsed = flashSaleCreateRequestSchema.parse(create);
      expect(parsed).toMatchObject({
        buckets: 16,
        perUserLimit: 2,
        admissionRatePerSecond: 2000,
      });
    });

    it('S11 AS-15: refuses an unknown property (shopId is never in the body)', () => {
      expect(
        flashSaleCreateRequestSchema.safeParse({ ...create, shopId: shop })
          .success,
      ).toBe(false);
    });

    it.each([
      ['units 0', { units: 0 }],
      ['units above 1,000,000', { units: 1_000_001 }],
      ['buckets 0', { buckets: 0 }],
      ['buckets 257', { buckets: 257 }],
      ['perUserLimit 0', { perUserLimit: 0 }],
      ['perUserLimit 21', { perUserLimit: 21 }],
      ['perUserLimit above units', { units: 2, perUserLimit: 3 }],
      ['rate 0', { admissionRatePerSecond: 0 }],
      ['rate 10001', { admissionRatePerSecond: 10_001 }],
      ['price 0', { priceMinor: 0 }],
      ['fractional price', { priceMinor: 10.5 }],
      ['unsafe price', { priceMinor: Number.MAX_SAFE_INTEGER + 2 }],
      ['product not a uuid', { productId: 'abc' }],
      ['start not a datetime', { startsAt: 'tomorrow' }],
      ['end before start', { endsAt: '2030-01-01T09:00:00.000Z' }],
      ['end equal to start', { endsAt: starts }],
      ['window over 24 h', { endsAt: '2030-01-02T10:00:00.001Z' }],
    ])('S11 AS-15: refuses %s', (_name, change) => {
      expect(
        flashSaleCreateRequestSchema.safeParse({ ...create, ...change })
          .success,
      ).toBe(false);
    });

    it('S11 AS-15: accepts the range limits and a 24 h window', () => {
      expect(
        flashSaleCreateRequestSchema.safeParse({
          ...create,
          units: 1_000_000,
          buckets: 256,
          perUserLimit: 20,
          admissionRatePerSecond: 10_000,
          priceMinor: Number.MAX_SAFE_INTEGER,
          endsAt: '2030-01-02T10:00:00.000Z',
        }).success,
      ).toBe(true);
    });
  });

  describe('flashSaleMemberSchema and flashSalePageSchema', () => {
    it('S11 AS-14: parses a scheduled sale with null stats', () => {
      expect(flashSaleMemberSchema.parse(member)).toEqual(member);
    });

    it('S11 AS-18: parses a loaded sale with exact stats', () => {
      const loaded = {
        ...member,
        status: 'LOADED',
        stats: {
          unitsLoaded: 3000,
          unitsRemaining: 2990,
          unitsHeld: 4,
          unitsSold: 6,
        },
      };
      expect(flashSaleMemberSchema.parse(loaded)).toEqual(loaded);
    });

    it('S11 AS-22: parses a failed start with its reason', () => {
      expect(
        flashSaleMemberSchema.safeParse({
          ...member,
          status: 'START_FAILED',
          statusReason: 'insufficient_stock',
        }).success,
      ).toBe(true);
    });

    it('S11 AS-18: refuses an unknown status or reason and an unknown field', () => {
      expect(
        flashSaleMemberSchema.safeParse({ ...member, status: 'LIVE' }).success,
      ).toBe(false);
      expect(
        flashSaleMemberSchema.safeParse({ ...member, statusReason: 'other' })
          .success,
      ).toBe(false);
      expect(
        flashSaleMemberSchema.safeParse({ ...member, extra: 1 }).success,
      ).toBe(false);
    });

    it('S11 AS-18: a page is items plus a nullable cursor', () => {
      expect(
        flashSalePageSchema.parse({ items: [member], nextCursor: null }),
      ).toEqual({ items: [member], nextCursor: null });
      expect(flashSalePageSchema.safeParse({ items: [member] }).success).toBe(
        false,
      );
    });
  });

  describe('flashSalePublicSchema', () => {
    it('S11 AS-38: parses the public body', () => {
      expect(flashSalePublicSchema.parse(publicView)).toEqual(publicView);
    });

    it.each([
      ['units', { units: 3000 }],
      ['buckets', { buckets: 16 }],
      ['admissionRatePerSecond', { admissionRatePerSecond: 2000 }],
      ['shopId', { shopId: shop }],
    ])('S11 AS-38: refuses the internal field %s', (_name, extra) => {
      expect(
        flashSalePublicSchema.safeParse({ ...publicView, ...extra }).success,
      ).toBe(false);
    });

    it('S11 AS-38: UPCOMING carries a null remainingApprox', () => {
      expect(
        flashSalePublicSchema.safeParse({
          ...publicView,
          state: 'UPCOMING',
          remainingApprox: null,
        }).success,
      ).toBe(true);
    });

    it('S11 AS-40: a degraded view has a null remainingApprox and degraded true', () => {
      expect(
        flashSalePublicSchema.safeParse({
          ...publicView,
          remainingApprox: null,
          degraded: true,
        }).success,
      ).toBe(true);
      expect(
        flashSalePublicSchema.safeParse({ ...publicView, degraded: false })
          .success,
      ).toBe(false);
    });

    it('S11 AS-41: remainingApprox is never negative or fractional', () => {
      expect(
        flashSalePublicSchema.safeParse({ ...publicView, remainingApprox: -1 })
          .success,
      ).toBe(false);
      expect(
        flashSalePublicSchema.safeParse({ ...publicView, remainingApprox: 1.5 })
          .success,
      ).toBe(false);
    });

    it('S11 AS-38: an unknown state is refused', () => {
      expect(
        flashSalePublicSchema.safeParse({ ...publicView, state: 'LOADED' })
          .success,
      ).toBe(false);
    });

    it('S11 AS-39: the batch response is an array of public views', () => {
      expect(flashSalesResponseSchema.parse([publicView])).toEqual([
        publicView,
      ]);
      expect(flashSalesResponseSchema.parse([])).toEqual([]);
    });
  });

  describe('flashSaleEventSchemas', () => {
    const base = { saleId: id, shopId: shop, productId: product };
    const valid: Record<string, Record<string, unknown>> = {
      'flashsale.loaded': {
        ...base,
        units: 3000,
        buckets: 16,
        startsAt: starts,
        endsAt: ends,
      },
      'flashsale.ended': base,
      'flashsale.reconciled': {
        ...base,
        units: 3000,
        unitsSold: 2400,
        unitsReturned: 600,
        driftUnits: 0,
      },
      'flashsale.cancelled': base,
      'flashsale.start_failed': { ...base, reason: 'insufficient_stock' },
      'flashsale.sold_out': base,
      'flashsale.oversold': {
        ...base,
        excessUnits: 4,
        cancelledOrderIds: [id],
        unresolvedPaidUnits: 0,
      },
    };

    it('S11 AS-37: has exactly the seven event types', () => {
      expect(Object.keys(flashSaleEventSchemas).sort()).toEqual(
        Object.keys(valid).sort(),
      );
    });

    it.each(Object.keys(valid))('S11 AS-37: %s parses its payload', (type) => {
      const schema =
        flashSaleEventSchemas[type as keyof typeof flashSaleEventSchemas];
      expect(schema.parse(valid[type])).toEqual(valid[type]);
    });

    it.each(Object.keys(valid))(
      'S11 AS-37: %s refuses a payload without saleId',
      (type) => {
        const schema =
          flashSaleEventSchemas[type as keyof typeof flashSaleEventSchemas];
        const { saleId: _saleId, ...rest } = valid[type];
        expect(schema.safeParse(rest).success).toBe(false);
      },
    );
  });
});
