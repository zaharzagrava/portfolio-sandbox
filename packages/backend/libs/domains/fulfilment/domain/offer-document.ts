import { isOfferVisible } from './offer-visibility';

export interface StockFacts {
  pickupPointId: string;
  productId: string;
  quantity: number;
  version: number;
}

export interface PointFacts {
  id: string;
  shopId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  active: boolean;
  version: number;
}

export interface ProductCopyFacts {
  productId: string;
  title: string;
  category: string;
  priceMinor: number;
  currency: string;
  status: string;
  isSandbox: boolean;
  version: number;
}

export interface ShopCopyFacts {
  shopId: string;
  status: string;
  version: number;
}

/** One document of the availability index (data-model.md). */
export interface OfferDocument {
  productId: string;
  pickupPointId: string;
  shopId: string;
  title: string;
  category: string;
  priceMinor: number;
  currency: string;
  pointName: string;
  pointAddress: string;
  quantity: number;
  location: { lat: number; lon: number };
  pointActive: boolean;
  isSandbox: boolean;
  productStatus: string;
  shopStatus: string;
  stockVersion: number;
  pointVersion: number;
  productVersion: number;
  shopVersion: number;
  docVersion: number;
}

export interface OfferWrite {
  id: string;
  /** External version: the sum of the four source versions, so a replay in any order converges on the highest sum. */
  version: number;
  /** `null`: the offer is not visible, the index must not hold it (a versioned delete). */
  document: OfferDocument | null;
}

/**
 * The document a (point, product) pair should have in the index, as a pure function of the current state of its four
 * sources (S19 FR-030, FR-035). Whatever order events arrive in, the projector rebuilds this from its own tables, so
 * the result depends on state only. A missing product or shop copy makes the offer invisible (fail closed).
 */
export function buildOfferDocument(sources: {
  stock: StockFacts;
  point: PointFacts;
  product: ProductCopyFacts | null;
  shop: ShopCopyFacts | null;
}): OfferWrite {
  const { stock, point, product, shop } = sources;
  const version =
    stock.version +
    point.version +
    (product?.version ?? 0) +
    (shop?.version ?? 0);
  const id = `${stock.pickupPointId}:${stock.productId}`;
  const visible = isOfferVisible({
    quantity: stock.quantity,
    pointActive: point.active,
    shopStatus: shop?.status ?? null,
    productStatus: product?.status ?? null,
    isSandbox: product?.isSandbox ?? false,
  });
  if (!visible || !product || !shop) return { id, version, document: null };
  return {
    id,
    version,
    document: {
      productId: stock.productId,
      pickupPointId: stock.pickupPointId,
      shopId: point.shopId,
      title: product.title,
      category: product.category,
      priceMinor: product.priceMinor,
      currency: product.currency,
      pointName: point.name,
      pointAddress: point.address,
      quantity: stock.quantity,
      location: { lat: point.lat, lon: point.lng },
      pointActive: point.active,
      isSandbox: product.isSandbox,
      productStatus: product.status,
      shopStatus: shop.status,
      stockVersion: stock.version,
      pointVersion: point.version,
      productVersion: product.version,
      shopVersion: shop.version,
      docVersion: version,
    },
  };
}
