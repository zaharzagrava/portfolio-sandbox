import { track } from '@/lib/analytics/track';

/**
 * The two W03 events of FR-090, through W02's `track()` (which sends nothing under Global Privacy Control or Do Not Track).
 * The props are exactly the listed ones: no titles, totals or personal data can be passed in. "Once per view" is the
 * caller's job (a ref guard in the component); these functions only shape and emit.
 */
export function trackAddToCart(input: { productId: string; category?: string }): void {
  track({
    name: 'add_to_cart',
    props: { product_id: input.productId, ...(input.category ? { category: input.category } : {}) },
  });
}

export type CheckoutStep = 'cart' | 'review' | 'pay' | 'success';

export function trackCheckoutStep(input: { step: CheckoutStep; items: number; orderId?: string }): void {
  const items = Number.isFinite(input.items) ? Math.max(0, Math.trunc(input.items)) : 0;
  track({
    name: 'checkout_step',
    props: { step: input.step, items, ...(input.orderId ? { order_id: input.orderId } : {}) },
  });
}
