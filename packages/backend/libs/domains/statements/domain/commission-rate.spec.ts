import { lookupRate, type RateBelief } from './rate-lookup';

const SHOP_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SHOP_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const at = (iso: string) => new Date(iso);
const recorded = at('2026-01-01T00:00:00Z');

const belief = (
  shopId: string | null,
  category: string,
  rateBps: number,
  extra: Partial<RateBelief> = {},
): RateBelief => ({
  id: `${shopId ?? 'default'}-${category}-${rateBps}`,
  shopId,
  category,
  rateBps,
  validFrom: null,
  validTo: null,
  recordedFrom: recorded,
  recordedTo: null,
  ...extra,
});

describe('S16 AS-04 rate precedence and boundaries', () => {
  const beliefs = [
    belief(SHOP_A, 'electronics', 700),
    belief(SHOP_A, '*', 900),
    belief(null, 'electronics', 800),
    belief(null, '*', 1000),
  ];
  const now = at('2026-04-01T00:00:00Z');

  it.each([
    [SHOP_A, 'electronics', 700, 'shop_category'],
    [SHOP_A, 'books', 900, 'shop_any'],
    [SHOP_B, 'electronics', 800, 'default_category'],
    [SHOP_B, 'books', 1000, 'default_any'],
  ])(
    'S16 AS-04: shop %s category %s resolves to %i bps by rule %s',
    (shopId, category, rateBps, rule) => {
      const found = lookupRate(beliefs, shopId, category, now, now);
      expect(found?.rateBps).toBe(rateBps);
      expect(found?.rule).toBe(rule);
    },
  );

  it('S16 AS-04: a rate is valid for validFrom <= t < validTo', () => {
    const rows = [
      belief(null, '*', 1000, { validTo: at('2026-03-01T00:00:00Z') }),
      belief(null, '*', 800, { validFrom: at('2026-03-01T00:00:00Z') }),
    ];
    const known = at('2026-04-01T00:00:00Z');
    expect(
      lookupRate(rows, SHOP_A, 'x', at('2026-02-28T23:59:59.999Z'), known)
        ?.rateBps,
    ).toBe(1000);
    expect(
      lookupRate(rows, SHOP_A, 'x', at('2026-03-01T00:00:00Z'), known)
        ?.rateBps,
    ).toBe(800);
  });

  it('S16 AS-04: a belief is known for recordedFrom <= K < recordedTo', () => {
    const rows = [
      belief(null, '*', 1000, { recordedTo: at('2026-04-10T00:00:00Z') }),
      belief(null, '*', 750, { recordedFrom: at('2026-04-10T00:00:00Z') }),
    ];
    const valid = at('2026-06-01T00:00:00Z');
    expect(
      lookupRate(rows, SHOP_A, 'x', valid, at('2026-04-09T23:59:59.999Z'))
        ?.rateBps,
    ).toBe(1000);
    expect(
      lookupRate(rows, SHOP_A, 'x', valid, at('2026-04-10T00:00:00Z'))?.rateBps,
    ).toBe(750);
  });

  it('S16 AS-04: nothing resolves when no belief covers the instant', () => {
    expect(
      lookupRate([belief(SHOP_A, 'x', 5)], SHOP_B, 'x', now, now),
    ).toBeNull();
  });

  it('S16 AS-04: category matching ignores case and surrounding spaces of the stored value', () => {
    const rows = [belief(null, 'electronics', 800), belief(null, '*', 1000)];
    expect(lookupRate(rows, SHOP_A, 'electronics', now, now)?.rule).toBe(
      'default_category',
    );
  });
});
