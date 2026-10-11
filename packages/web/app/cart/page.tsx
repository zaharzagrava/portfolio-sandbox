import type { Metadata } from 'next';
import { CartView } from '@/components/cart/cart-view';

export const metadata: Metadata = { title: 'Your cart' };

/**
 * The cart is a static shell (W03 AS-70): it reads nothing from the request (no cookies, params or search params) and
 * caches nothing per visitor. The cart itself is fetched in the browser by `<CartView />`, for guests (the HttpOnly guest
 * cookie travels by itself) and members alike.
 */
export default function CartPage() {
  return <CartView />;
}
