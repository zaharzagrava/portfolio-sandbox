/**
 * Version guard of the community-owned product copy (S26 B4, FR-023, R-6). The copy keeps the newest state seen per
 * product by `productVersion`; an older or equal event is ignored, `DELETED` is final (a tombstone that also survives a
 * deletion seen before the creation). Pure: no clock, no store.
 */
export type ProductCopyStatus = 'ACTIVE' | 'ARCHIVED' | 'DELETED';

export interface ProductCopy {
  productId: string;
  shopId: string;
  title: string;
  /** Integer minor units. */
  priceMinor: number;
  currency: string;
  status: ProductCopyStatus;
  isSandbox: boolean;
  productVersion: number;
}

export type ProductCopyEvent =
  | { kind: 'snapshot'; copy: ProductCopy }
  | {
      kind: 'deleted';
      productId: string;
      shopId: string;
      productVersion: number;
    };

export interface GuardResult {
  /** The event changed the copy and the store must write `copy`. */
  applied: boolean;
  /** The copy after the event (unchanged when ignored). */
  copy: ProductCopy | null;
}

export function applyProductEvent(
  current: ProductCopy | null,
  event: ProductCopyEvent,
): GuardResult {
  const version =
    event.kind === 'snapshot'
      ? event.copy.productVersion
      : event.productVersion;
  if (current) {
    if (current.status === 'DELETED' || version <= current.productVersion)
      return { applied: false, copy: current };
  }
  if (event.kind === 'snapshot')
    return { applied: true, copy: { ...event.copy } };
  return {
    applied: true,
    copy: {
      productId: event.productId,
      shopId: event.shopId,
      title: current?.title ?? '',
      priceMinor: current?.priceMinor ?? 0,
      currency: current?.currency ?? '',
      isSandbox: current?.isSandbox ?? false,
      status: 'DELETED',
      productVersion: event.productVersion,
    },
  };
}
