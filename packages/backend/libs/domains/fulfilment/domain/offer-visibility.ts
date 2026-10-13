export interface OfferFacts {
  quantity: number;
  pointActive: boolean;
  /** `null`: no copy of the shop yet (fail closed). */
  shopStatus: string | null;
  /** `null`: no copy of the product yet (fail closed). */
  productStatus: string | null;
  isSandbox: boolean;
}

/**
 * The one visibility rule (S19 FR-023): stock above zero, an active point, an `ACTIVE` shop, a product that is not
 * archived and not sandbox. The projector uses it to index or delete a document; the exact browse mirrors it in SQL
 * (checked against this table by the browse spec); search and clusters trust the presence of the document.
 */
export const isOfferVisible = (facts: OfferFacts): boolean =>
  facts.quantity > 0 &&
  facts.pointActive &&
  facts.shopStatus === 'ACTIVE' &&
  facts.productStatus === 'ACTIVE' &&
  !facts.isSandbox;
