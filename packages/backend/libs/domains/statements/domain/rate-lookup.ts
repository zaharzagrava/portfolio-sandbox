/**
 * Rate resolution over bitemporal beliefs (S16 FR-004). The SQL reader applies the same precedence; this version is
 * the specification of it and serves the in-memory callers (as-of answers, recomputation tests).
 */
export const ANY_CATEGORY = '*';

export type RateRule =
  'shop_category' | 'shop_any' | 'default_category' | 'default_any';

export interface RateBelief {
  id: string;
  /** `null` is the marketplace default. */
  shopId: string | null;
  category: string;
  rateBps: number;
  /** `null` is unbounded. Valid for `validFrom <= t < validTo`. */
  validFrom: Date | null;
  validTo: Date | null;
  /** Known for `recordedFrom <= K < recordedTo`; `null` is still current. */
  recordedFrom: Date;
  recordedTo: Date | null;
}

export interface RateMatch {
  rateBps: number;
  rule: RateRule;
  belief: RateBelief;
}

const covers = (
  from: Date | null,
  to: Date | null,
  instant: Date,
): boolean =>
  (from === null || from.getTime() <= instant.getTime()) &&
  (to === null || instant.getTime() < to.getTime());

const ORDER: { shop: boolean; any: boolean; rule: RateRule }[] = [
  { shop: true, any: false, rule: 'shop_category' },
  { shop: true, any: true, rule: 'shop_any' },
  { shop: false, any: false, rule: 'default_category' },
  { shop: false, any: true, rule: 'default_any' },
];

export function lookupRate(
  beliefs: RateBelief[],
  shopId: string,
  category: string,
  validAt: Date,
  knownAt: Date,
): RateMatch | null {
  const known = beliefs.filter(
    (b) =>
      covers(b.validFrom, b.validTo, validAt) &&
      covers(b.recordedFrom, b.recordedTo, knownAt),
  );
  for (const step of ORDER) {
    const wantedShop = step.shop ? shopId : null;
    const wantedCategory = step.any ? ANY_CATEGORY : category;
    const belief = known.find(
      (b) => b.shopId === wantedShop && b.category === wantedCategory,
    );
    if (belief) return { rateBps: belief.rateBps, rule: step.rule, belief };
  }
  return null;
}
