import {
  payoutConsumedSchemas,
  payoutEventSchemas,
  webhookPayoutEventSchemas,
} from '@marketplace-sandbox/contracts';

const ID = '0192b0a0-0000-7000-8000-000000000001';
const SHOP = '0192b0a0-0000-7000-8000-000000000002';
const base = {
  payoutId: ID,
  shopId: SHOP,
  periodStart: '2026-10-05',
  amountMinor: 45_000,
  currency: 'EUR',
  payoutVersion: 2,
};

const fixtures = {
  'payout.created': { ...base, reserveHeldMinor: 5_000, payoutVersion: 1 },
  'payout.paid': {
    ...base,
    transferRef: 'tr_123',
    paidAt: '2026-10-05T06:00:03.000Z',
  },
  'payout.failed': { ...base, failureCode: 'destination_rejected' },
  'payout.cancelled': {
    ...base,
    cancelledBy: SHOP,
    reason: 'seller asked to stop',
  },
  'payout.in_doubt': { ...base, inDoubtSince: '2026-10-05T06:00:03.000Z' },
  'payout.discrepancy_detected': {
    payoutId: ID,
    shopId: SHOP,
    kind: 'amount',
    payoutVersion: 3,
  },
} as const;

describe('Payout event contracts (parse tests)', () => {
  it.each(Object.entries(fixtures))(
    'S15 AS-50: %s parses with the producer schema',
    (type, payload) => {
      const schema = payoutEventSchemas[type as keyof typeof fixtures];
      expect(schema.safeParse(payload).success).toBe(true);
    },
  );

  it('S15 AS-50: exactly the six events exist', () => {
    expect(Object.keys(payoutEventSchemas).sort()).toEqual(
      Object.keys(fixtures).sort(),
    );
  });

  it.each(['payout.paid', 'payout.failed'] as const)(
    'S15 AS-50: %s is accepted by the S43 webhook schema and the S28 consumer schema',
    (type) => {
      expect(
        webhookPayoutEventSchemas[type].safeParse(fixtures[type]).success,
      ).toBe(true);
      const consumed = payoutConsumedSchemas[type].safeParse(fixtures[type]);
      expect(consumed.success).toBe(true);
      if (consumed.success) {
        const parsed = consumed.data as Record<string, unknown>;
        for (const key of [
          'payoutId',
          'shopId',
          'amountMinor',
          'currency',
          'payoutVersion',
        ])
          expect(parsed[key]).toEqual(
            (fixtures[type] as Record<string, unknown>)[key],
          );
      }
    },
  );

  it('S15 AS-50: no payload can carry a destination or a secret field', () => {
    for (const [type, payload] of Object.entries(fixtures)) {
      const schema = payoutEventSchemas[type as keyof typeof fixtures];
      const parsed = schema.safeParse({
        ...payload,
        destination: 'acct_secret1234',
        providerAccountId: 'acct_secret1234',
        idempotencyKey: 'k',
      });
      // strict: an unknown property is refused rather than carried
      expect(parsed.success).toBe(false);
    }
  });

  it('S15 AS-25: the discrepancy kinds are the closed set of the spec', () => {
    for (const kind of [
      'amount',
      'currency',
      'destination',
      'missing_transfer',
      'reversed_at_provider',
      'conflicting_outcome',
    ])
      expect(
        payoutEventSchemas['payout.discrepancy_detected'].safeParse({
          ...fixtures['payout.discrepancy_detected'],
          kind,
        }).success,
      ).toBe(true);
    expect(
      payoutEventSchemas['payout.discrepancy_detected'].safeParse({
        ...fixtures['payout.discrepancy_detected'],
        kind: 'other',
      }).success,
    ).toBe(false);
  });
});
