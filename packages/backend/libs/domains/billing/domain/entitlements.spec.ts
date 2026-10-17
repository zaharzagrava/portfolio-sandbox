import {
  ENTITLEMENT_KEYS,
  FREE_BUYER,
  FREE_SHOP,
  checkLimit,
  freeTier,
  hasEntitlement,
  quotaMetric,
  type Entitlements,
} from './entitlements';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

const PRO: Entitlements = {
  maxProducts: 10000,
  seats: 25,
  auctions: true,
  apiCallsPerMonth: 1000000,
  assistantTokensPerMonth: 5000000,
};
const PLUS: Entitlements = {
  freeShipping: true,
  earlyAccessDrops: true,
  assistantTokensPerMonth: 2000000,
};

describe('S18 free tiers (research R-2)', () => {
  it('S18 AS-02: the free shop tier is exactly the DS-1 numbers and the free buyer tier carries the assistant allowance', () => {
    expect(FREE_SHOP).toEqual({
      maxProducts: 10,
      seats: 1,
      auctions: false,
      apiCallsPerMonth: 1000,
      assistantTokensPerMonth: 0,
    });
    expect(FREE_BUYER).toEqual({ assistantTokensPerMonth: 200000 });
    expect(freeTier('SHOP')).toEqual(FREE_SHOP);
    expect(freeTier('USER')).toEqual(FREE_BUYER);
  });

  it('S18 AS-02: a caller cannot change the tier by mutating what it was given', () => {
    const tier = freeTier('SHOP');
    tier.maxProducts = 999;
    expect(freeTier('SHOP').maxProducts).toBe(10);
  });
});

describe('S18 hasEntitlement', () => {
  it.each([
    ['pro auctions (true)', PRO, 'auctions', true],
    ['free shop auctions (false)', FREE_SHOP, 'auctions', false],
    ['plus freeShipping (true)', PLUS, 'freeShipping', true],
    ['free buyer freeShipping (absent)', FREE_BUYER, 'freeShipping', false],
    ['plus earlyAccessDrops (true)', PLUS, 'earlyAccessDrops', true],
    ['pro seats (25 > 0)', PRO, 'seats', true],
  ] as const)('S18 AS-03: %s', (_name, entitlements, key, expected) => {
    expect(hasEntitlement(entitlements, key)).toBe(expected);
  });

  it.each([
    ['free shop seats 1', FREE_SHOP, 'seats', true],
    [
      'free shop assistantTokensPerMonth 0',
      FREE_SHOP,
      'assistantTokensPerMonth',
      false,
    ],
    ['a key the subject lacks', FREE_BUYER, 'maxProducts', false],
    ['an explicit false', { auctions: false }, 'auctions', false],
    ['a negative number is not present', { seats: -1 }, 'seats', false],
  ] as const)(
    'S18 AS-04: numeric keys count as present when positive: %s',
    (_n, entitlements, key, expected) => {
      expect(hasEntitlement(entitlements as Entitlements, key)).toBe(expected);
    },
  );

  it.each(['teleport', '', 'AUCTIONS', '__proto__', 'constructor', 'toString'])(
    'S18 AS-05: the unknown key %j rejects unknown_entitlement',
    (key) => {
      expect(codeOf(() => hasEntitlement(PRO, key))).toBe(
        'unknown_entitlement',
      );
    },
  );

  it('S18 AS-05: every allowlisted key is accepted', () => {
    for (const key of ENTITLEMENT_KEYS)
      expect(() => hasEntitlement(PRO, key)).not.toThrow();
    expect(ENTITLEMENT_KEYS).toEqual([
      'freeShipping',
      'earlyAccessDrops',
      'maxProducts',
      'seats',
      'auctions',
      'apiCallsPerMonth',
      'assistantTokensPerMonth',
      'maxCompetitorWatches',
    ]);
  });

  it('S41: maxCompetitorWatches is a count limit, 0 where a plan does not carry it', () => {
    expect(checkLimit(FREE_SHOP, 'maxCompetitorWatches', 0)).toEqual({
      allowed: false,
      limit: 0,
      remaining: 0,
    });
    expect(
      checkLimit({ maxCompetitorWatches: 5 }, 'maxCompetitorWatches', 4),
    ).toEqual({ allowed: true, limit: 5, remaining: 1 });
  });
});

describe('S18 checkLimit', () => {
  it.each([
    [PRO, 'maxProducts', 9999, { allowed: true, limit: 10000, remaining: 1 }],
    [PRO, 'maxProducts', 10000, { allowed: false, limit: 10000, remaining: 0 }],
    [PRO, 'maxProducts', 0, { allowed: true, limit: 10000, remaining: 10000 }],
    [PRO, 'maxProducts', 20000, { allowed: false, limit: 10000, remaining: 0 }],
    [FREE_SHOP, 'maxProducts', 10, { allowed: false, limit: 10, remaining: 0 }],
    [FREE_SHOP, 'seats', 0, { allowed: true, limit: 1, remaining: 1 }],
    [FREE_BUYER, 'maxProducts', 0, { allowed: false, limit: 0, remaining: 0 }],
  ] as const)('S18 AS-07: %#', (entitlements, key, current, expected) => {
    expect(checkLimit(entitlements as Entitlements, key, current)).toEqual(
      expected,
    );
  });

  it('S18 AS-07: a key that is not a count limit rejects not_a_limit', () => {
    expect(codeOf(() => checkLimit(PRO, 'auctions', 0))).toBe('not_a_limit');
    expect(codeOf(() => checkLimit(PRO, 'apiCallsPerMonth', 0))).toBe(
      'not_a_limit',
    );
  });

  it('S18 AS-05: an unknown key rejects unknown_entitlement before anything else is looked at', () => {
    expect(codeOf(() => checkLimit(PRO, 'teleport', -5))).toBe(
      'unknown_entitlement',
    );
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'S18 AS-07: the current value %p rejects invalid_current_value',
    (current) => {
      expect(codeOf(() => checkLimit(PRO, 'maxProducts', current))).toBe(
        'invalid_current_value',
      );
    },
  );

  it('S18 AS-07: a current value that is not a number rejects invalid_current_value', () => {
    expect(
      codeOf(() => checkLimit(PRO, 'maxProducts', '5' as unknown as number)),
    ).toBe('invalid_current_value');
  });
});

describe('S18 quotaMetric', () => {
  it('S18 AS-08: the quota keys map to their usage metric', () => {
    expect(quotaMetric('apiCallsPerMonth')).toBe('api.calls');
    expect(quotaMetric('assistantTokensPerMonth')).toBe('llm.assistant.tokens');
  });

  it('S18 AS-08: a key that is not a quota rejects not_a_quota; an unknown key unknown_entitlement', () => {
    expect(codeOf(() => quotaMetric('maxProducts'))).toBe('not_a_quota');
    expect(codeOf(() => quotaMetric('auctions'))).toBe('not_a_quota');
    expect(codeOf(() => quotaMetric('teleport'))).toBe('unknown_entitlement');
  });
});
