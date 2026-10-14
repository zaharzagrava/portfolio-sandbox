export type Visibility = 'PUBLIC' | 'SHOP_PRIVATE' | 'PLATFORM';

export type RetrievalScope =
  /** Buyer asking about a product: that product's public docs + its shop's public, product-less docs (shop FAQ). */
  | { kind: 'product'; productId: string; shopId: string }
  /** Seller help center: platform articles + the shop's own documents (public and private). */
  | { kind: 'shop'; shopId: string };

/** Where a document is managed: one shop, or the platform (help-center articles). */
export type DocumentScope =
  { kind: 'shop'; shopId: string } | { kind: 'platform' };

export interface PassageScope {
  visibility: Visibility;
  shopId: string | null;
  productId: string | null;
}

export interface ScopeDescription {
  visibilities: Visibility[];
  shopId: string;
  /** Set for a buyer scope: passages attached to this product, plus the shop's passages attached to none. */
  productId: string | null;
  includePlatform: boolean;
}

/**
 * The permission predicate of a retrieval, described as data (S47 FR-021, FR-022). The repository turns it into SQL that
 * sits inside both ranking statements and the hydration statement; `passageInScope` is the same rule as plain code, the
 * oracle the unit specs and the e2e isolation table agree on.
 */
export function describeScope(scope: RetrievalScope): ScopeDescription {
  return scope.kind === 'product'
    ? {
        visibilities: ['PUBLIC'],
        shopId: scope.shopId,
        productId: scope.productId,
        includePlatform: false,
      }
    : {
        visibilities: ['PUBLIC', 'SHOP_PRIVATE'],
        shopId: scope.shopId,
        productId: null,
        includePlatform: true,
      };
}

export function passageInScope(
  scope: RetrievalScope,
  passage: PassageScope,
): boolean {
  const d = describeScope(scope);
  if (passage.visibility === 'PLATFORM') return d.includePlatform;
  if (!d.visibilities.includes(passage.visibility)) return false;
  if (passage.shopId !== d.shopId) return false;
  return d.productId === null
    ? true
    : passage.productId === null || passage.productId === d.productId;
}

/** Stable text identity of a scope (cursor binding, metrics-free logs). */
export const scopeKey = (scope: RetrievalScope | DocumentScope): string =>
  scope.kind === 'platform'
    ? 'platform'
    : scope.kind === 'shop'
      ? `shop:${scope.shopId}`
      : `product:${scope.shopId}:${scope.productId}`;
