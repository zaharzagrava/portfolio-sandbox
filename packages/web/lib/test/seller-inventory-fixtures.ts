import { productMemberSchema, type ProductMemberView } from '@marketplace-sandbox/contracts';
import { SELLER_PRODUCT_ID, SELLER_SHOP_ID } from './seller-handlers';

/** A member view of a product, parsed with its contract schema so a drifting fixture fails loudly (W04 test-plan "UI unit"). */
export function productMemberFixture(overrides: Record<string, unknown> = {}): ProductMemberView {
  return productMemberSchema.parse({
    id: SELLER_PRODUCT_ID,
    shopId: SELLER_SHOP_ID,
    title: 'Handmade Ceramic Mug',
    description: 'Hand-thrown stoneware.',
    brand: 'Clay Works',
    category: 'kitchen',
    priceMinor: 2450,
    currency: 'EUR',
    rating: 0,
    tags: [],
    inStock: true,
    version: 3,
    viewCount: 0,
    quantity: 12,
    status: 'ACTIVE',
    externalSku: null,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-02T09:00:00.000Z',
    ...overrides,
  });
}
