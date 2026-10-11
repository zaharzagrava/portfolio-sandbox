import { CartFrame, CartSkeleton } from '@/components/cart/cart-skeleton';

/** Shown while the cart route streams: the heading and the three-line skeleton, announced as "Loading your cart". */
export default function Loading() {
  return (
    <CartFrame>
      <CartSkeleton />
    </CartFrame>
  );
}
