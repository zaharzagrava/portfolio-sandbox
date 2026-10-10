import type { ProductSnapshot } from '@marketplace-sandbox/contracts';
import { DEFAULT_BOOST_WEIGHTS } from '../domain/boost';
import { popularityMutation } from '../domain/index-document';
import { PRODUCT_INDEX, type ProductIndexPort } from '../domain/ports';
import {
  deliver,
  newId,
  productEvent,
  shopPlanEvent,
  snapshot,
  sponsorshipEvent,
} from './search-events';
import type { SearchTestApp } from './search-app';

export interface Seed extends Partial<ProductSnapshot> {
  /** popularity bucket 0-10, written the way the popularity job writes it */
  popularity?: number;
  sponsored?: boolean;
  /** a shop of its own (created PRO etc. through a plan event) */
  plan?: 'STARTER' | 'PRO' | 'ENTERPRISE';
}

/**
 * Puts products into the index the way production does: real `catalog.product_*` envelopes delivered to the real
 * consumer, signals through their own consumers. Returns the ids in the given order. Waits until all are searchable.
 */
export async function seedProducts(
  t: SearchTestApp,
  shopId: string,
  seeds: Seed[],
): Promise<string[]> {
  const ids: string[] = [];
  let version = 1;
  const index = t.app.get<ProductIndexPort>(PRODUCT_INDEX, { strict: false });
  for (const [i, seed] of seeds.entries()) {
    const { popularity, sponsored, plan, ...fields } = seed;
    const productId = fields.productId ?? newId();
    const shop = fields.shopId ?? shopId;
    ids.push(productId);
    if (plan)
      await deliver(t.app).shops(shopPlanEvent(shop, plan, version++, t.clock.now()));
    await deliver(t.app).products(
      productEvent(
        'created',
        snapshot({
          title: `Product ${i}`,
          createdAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
          ...fields,
          productId,
          shopId: shop,
        }),
        t.clock.now(),
      ),
    );
    if (sponsored)
      await deliver(t.app).sponsorship(
        sponsorshipEvent(productId, shop, true, 1, t.clock.now()),
      );
    if (popularity !== undefined)
      await index.mutate([
        {
          id: productId,
          mutation: popularityMutation({
            productId,
            bucket: popularity,
            at: t.clock.now(),
            weights: DEFAULT_BOOST_WEIGHTS,
          }),
        },
      ]);
  }
  await t.refresh();
  return ids;
}
