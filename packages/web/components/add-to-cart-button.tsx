'use client';

import { ShoppingCart } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { nextQuantity, useCart, useSetCartQuantity } from '@/lib/api/cart';
import { apiErrorMessage } from '@/lib/api/errors';

/** Adds one unit (the cart API sets absolute quantities, so it reads the current line first). */
export function AddToCartButton({ productId, disabled }: { productId: string; disabled?: boolean }) {
  const { data: items } = useCart();
  const setQuantity = useSetCartQuantity();
  const current = items?.find((i) => i.productId === productId)?.quantity ?? 0;

  const add = () =>
    setQuantity.mutate(
      { productId, quantity: nextQuantity(current, 1) },
      {
        onSuccess: () => toast.success('Added to cart'),
        onError: (error) => toast.error(apiErrorMessage(error, 'Could not add to cart.')),
      },
    );

  return (
    <Button size="lg" className="w-full sm:w-auto font-medium" onClick={add} disabled={disabled || setQuantity.isPending}>
      <ShoppingCart className="mr-2 h-4 w-4" />
      {setQuantity.isPending ? 'Adding...' : disabled ? 'Out of stock' : 'Add to Cart'}
    </Button>
  );
}
