/**
 * The public resources at the latest version (FR-026, FR-042): every body is built here from an explicit field list, so
 * no internal column, hash, secret or buyer datum can be serialized by accident. Older versions are derived from these
 * by the registry's downgraders.
 */
export interface Money {
  amount: number;
  currency: string;
}

export interface PublicProduct {
  id: string;
  object: 'product';
  livemode: boolean;
  title: string;
  description: string;
  price: Money;
  stock: number;
  category: string;
  brand: string;
  status: 'active' | 'archived';
  version: number;
  created_at: string;
  updated_at: string;
  shop?: { id: string; name: string; slug: string };
}

export interface PublicOrder {
  id: string;
  object: 'order';
  livemode: boolean;
  status: string;
  total: Money;
  lines: { product_id: string; quantity: number; unit_price: Money }[];
  created_at: string;
}

export interface PublicStock {
  object: 'stock';
  product_id: string;
  stock: number;
  livemode: boolean;
  updated_at: string;
}

export interface PublicList<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

/** What the catalog's member view carries (the fields the mapping reads; the catalog contract owns the rest). */
export interface CatalogMemberView {
  id: string;
  title: string;
  description: string;
  brand: string;
  category: string;
  priceMinor: number;
  currency: string;
  quantity: number;
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
  createdAt: string;
  updatedAt: string;
}

export const toPublicProduct = (
  p: CatalogMemberView,
  livemode: boolean,
): PublicProduct => ({
  id: p.id,
  object: 'product',
  livemode,
  title: p.title,
  description: p.description,
  price: { amount: p.priceMinor, currency: p.currency },
  stock: p.quantity,
  category: p.category,
  brand: p.brand,
  status: p.status === 'ARCHIVED' ? 'archived' : 'active',
  version: p.version,
  created_at: p.createdAt,
  updated_at: p.updatedAt,
});

export const toPublicStock = (
  p: CatalogMemberView,
  livemode: boolean,
): PublicStock => ({
  object: 'stock',
  product_id: p.id,
  stock: p.quantity,
  livemode,
  updated_at: p.updatedAt,
});

export interface OrderSliceView {
  shopOrderId: string;
  status: string;
  subtotalMinor: number;
  currency: string;
  createdAt: string;
  items: { productId: string; quantity: number; unitPriceMinor: number }[];
}

/** Only the shop's subtotal and lines; the buyer, address and payment data never get here (FR-041). */
export const toPublicOrder = (
  o: OrderSliceView,
  livemode: boolean,
): PublicOrder => ({
  id: o.shopOrderId,
  object: 'order',
  livemode,
  status: o.status,
  total: { amount: o.subtotalMinor, currency: o.currency },
  lines: o.items.map((i) => ({
    product_id: i.productId,
    quantity: i.quantity,
    unit_price: { amount: i.unitPriceMinor, currency: o.currency },
  })),
  created_at: o.createdAt,
});

export const list = <T>(
  data: T[],
  nextCursor: string | null,
): PublicList<T> => ({
  object: 'list',
  data,
  has_more: nextCursor !== null,
  next_cursor: nextCursor,
});

/** The sample the field names of each version are derived from (`fields=`), with every latest field present. */
export const PRODUCT_FIELD_SAMPLE: Record<string, unknown> = {
  id: '',
  object: 'product',
  livemode: true,
  title: '',
  description: '',
  price: { amount: 0, currency: '' },
  stock: 0,
  category: '',
  brand: '',
  status: 'active',
  version: 1,
  created_at: '',
  updated_at: '',
};

export const ORDER_FIELD_SAMPLE: Record<string, unknown> = {
  id: '',
  object: 'order',
  livemode: true,
  status: '',
  total: { amount: 0, currency: '' },
  lines: [],
  created_at: '',
};
