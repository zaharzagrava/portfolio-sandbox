'use client';

import { useEffect, useRef } from 'react';
import { track } from '@/lib/analytics/track';

/**
 * One `product_view` per page view of a product (W02 AS-67, FR-141), with its id and catalog category. The effect is keyed
 * by the product id and guarded, so the development double mount, re-renders and tab changes add none; opening another
 * product adds one for it. `track()` applies the privacy rule (Global Privacy Control, Do Not Track). Renders nothing.
 */
export function ProductView({ productId, category }: { productId: string; category: string }) {
  const last = useRef<string | null>(null);

  useEffect(() => {
    if (last.current === productId) return; // development mounts effects twice
    last.current = productId;
    track({ name: 'product_view', props: { product_id: productId, category } });
    // `category` belongs to the same product: a change of it alone is not another page view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  return null;
}
